/**
 * EPHERA — Reserved Transfer Domain Test (Stage 9)
 *
 * GOAL:
 * - Reserved-domain transferIds (high bit set) must never create or mutate sessions.
 * - Sender-generated transferIds must always stay in regular transfer domain.
 */

import { EpheraReceiver, MSG_START, MSG_CHUNK, MSG_END, MSG_ABORT, MSG_META } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';
import { EpheraSender } from '../sender.js';

const RESERVED_DOMAIN_BIT = 0x80;

class MockTransport {
  constructor() {
    this.onChunk = null;
  }

  receive(data) {
    if (this.onChunk) this.onChunk(data);
  }
}

class CaptureTransport {
  constructor() {
    this.frames = [];
    this._listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._listeners.delete(type);
  }

  async sendStream(stream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
        this.frames.push(frame);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
}

function makeStartFrame(transferId) {
  return new Uint8Array([MSG_START, ...transferId]);
}

function makeChunkFrame(transferId, chunkIndex, payload) {
  const frame = new Uint8Array(13 + payload.byteLength);
  frame[0] = MSG_CHUNK;
  frame.set(transferId, 1);
  frame[9] = (chunkIndex >>> 24) & 0xff;
  frame[10] = (chunkIndex >>> 16) & 0xff;
  frame[11] = (chunkIndex >>> 8) & 0xff;
  frame[12] = chunkIndex & 0xff;
  frame.set(payload, 13);
  return frame;
}

function makeEndFrame(transferId, totalChunks) {
  return new Uint8Array([
    MSG_END,
    ...transferId,
    (totalChunks >>> 24) & 0xff,
    (totalChunks >>> 16) & 0xff,
    (totalChunks >>> 8) & 0xff,
    totalChunks & 0xff,
  ]);
}

function makeAbortFrame(transferId) {
  return new Uint8Array([MSG_ABORT, ...transferId]);
}

function makeMetaFrame(transferId, flags, payload) {
  const meta = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const frame = new Uint8Array(12 + meta.byteLength);
  frame[0] = MSG_META;
  frame.set(transferId, 1);
  frame[9] = flags & 0xff;
  frame[10] = (meta.byteLength >>> 8) & 0xff;
  frame[11] = meta.byteLength & 0xff;
  frame.set(meta, 12);
  return frame;
}

function oneChunkStream() {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(new Uint8Array([0xaa]));
    },
  });
}

async function assertSenderIdsStayInRegularDomain(iterations = 64) {
  for (let i = 0; i < iterations; i++) {
    const transport = new CaptureTransport();
    const sender = new EpheraSender(transport, { weight: 1 });
    await sender.start(oneChunkStream());

    const start = transport.frames.find((f) => f[0] === MSG_START);
    if (!start) {
      throw new Error('FAIL: sender did not emit START frame');
    }

    const firstTransferByte = start[1] & 0xff;
    if ((firstTransferByte & RESERVED_DOMAIN_BIT) !== 0) {
      throw new Error(`FAIL: sender emitted reserved-domain transferId byte=${firstTransferByte}`);
    }

    sender.destroy();
  }
}

export async function runHandshakeDomainTest() {
  console.log('--- STARTING RESERVED DOMAIN TEST (STAGE 9) ---');

  const transport = new MockTransport();
  const receiver = new EpheraReceiver(transport);
  const sessionManager = new SessionManager();
  receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
  receiver.start();

  let created = 0;
  sessionManager.onSession = () => { created += 1; };

  const reservedId = new Uint8Array([0x80, 1, 2, 3, 4, 5, 6, 7]);
  const payload = new Uint8Array([0x11, 0x22]);
  const metaPayload = new Uint8Array([0x7b, 0x7d]); // "{}"

  transport.receive(makeStartFrame(reservedId));
  transport.receive(makeChunkFrame(reservedId, 0, payload));
  transport.receive(makeMetaFrame(reservedId, 0, metaPayload));
  transport.receive(makeEndFrame(reservedId, 1));
  transport.receive(makeAbortFrame(reservedId));

  if (created !== 0) {
    throw new Error(`FAIL: reserved-domain frames created ${created} session(s)`);
  }
  if (sessionManager.getSessionCount() !== 0) {
    throw new Error(`FAIL: reserved-domain frames mutated session map (${sessionManager.getSessionCount()})`);
  }

  // Sanity: regular-domain transferIds still route normally.
  const regularId = new Uint8Array([0x01, 1, 2, 3, 4, 5, 6, 7]);
  transport.receive(makeStartFrame(regularId));
  if (created !== 1) {
    throw new Error(`FAIL: regular-domain START did not create session (created=${created})`);
  }
  if (sessionManager.getSessionCount() !== 1) {
    throw new Error(`FAIL: expected 1 active session after regular START, got ${sessionManager.getSessionCount()}`);
  }
  transport.receive(makeAbortFrame(regularId));
  if (sessionManager.getSessionCount() !== 0) {
    throw new Error(`FAIL: regular-domain ABORT did not clean session (${sessionManager.getSessionCount()})`);
  }

  await assertSenderIdsStayInRegularDomain(64);

  receiver.destroy();
  sessionManager.destroy();

  console.log('--- RESERVED DOMAIN TEST (STAGE 9) PASSED ---');
}

if (typeof window !== 'undefined') {
  runHandshakeDomainTest().catch(console.error);
}
