/**
 * EPHERA — Receiver Backpressure Overflow Test (Stage 3.3)
 *
 * PURPOSE:
 * Prove that if the receiver consumer does not read, the per-session stream
 * buffering remains bounded by aborting deterministically (no unbounded queue).
 */

import { EpheraReceiver, MSG_START, MSG_CHUNK } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class MockTransport {
  constructor() {
    this.onChunk = null;
  }
  receive(data) {
    if (this.onChunk) this.onChunk(data);
  }
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

export async function runReceiverBackpressureOverflowTest() {
  console.log('--- STARTING RECEIVER BACKPRESSURE OVERFLOW TEST ---');

  const transport = new MockTransport();
  const receiver = new EpheraReceiver(transport);
  const sessionManager = new SessionManager();

  receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
  receiver.start();

  const transferId = new Uint8Array(8);
  crypto.getRandomValues(transferId);

  let session = null;
  let reader = null;
  let closed = null;

  sessionManager.onSession = (s) => {
    session = s;
    const stream = s.getStream();
    reader = stream.getReader(); // Intentionally do not drain.
    closed = reader.closed;
  };

  // START
  transport.receive(new Uint8Array([MSG_START, ...transferId]));

  if (!session) throw new Error('FAIL: session not created');
  if (sessionManager.getSessionCount() !== 1) {
    throw new Error(`FAIL: expected 1 session, got ${sessionManager.getSessionCount()}`);
  }

  // Send until the session aborts due to bounded buffering.
  const payload = new Uint8Array(256 * 1024); // 256KB
  const MAX_CHUNKS = 512;

  let aborted = false;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    transport.receive(makeChunkFrame(transferId, i, payload));
    if (sessionManager.getSessionCount() === 0) {
      aborted = true;
      break;
    }
  }

  if (!aborted) {
    throw new Error('FAIL: expected session to abort due to receiver backpressure overflow');
  }

  // The stream should error (not close) with the overflow reason.
  const outcome = await Promise.race([
    closed
      .then(() => ({ ok: true, err: null }))
      .catch((err) => ({ ok: false, err })),
    sleep(1000).then(() => ({ timeout: true })),
  ]);

  if (outcome && outcome.timeout) {
    throw new Error('FAIL: timeout waiting for stream to error');
  }

  if (outcome && outcome.ok) {
    throw new Error('FAIL: stream closed cleanly, expected error');
  }

  const msg = outcome && outcome.err && outcome.err.message ? outcome.err.message : String(outcome && outcome.err);
  if (!String(msg).includes('receiver backpressure overflow')) {
    throw new Error(`FAIL: expected overflow error, got: ${String(msg)}`);
  }

  try { reader.releaseLock(); } catch {}

  receiver.destroy();
  sessionManager.destroy();

  console.log('--- RECEIVER BACKPRESSURE OVERFLOW TEST PASSED ---');
}

if (typeof window !== 'undefined') {
  runReceiverBackpressureOverflowTest().catch(console.error);
}

