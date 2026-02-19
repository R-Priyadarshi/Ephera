/**
 * EPHERA — Metadata Test (Stage 7)
 *
 * GOAL:
 * Prove META is delivered once per transfer and can carry
 * filename/type/size, in both plaintext and passphrase-encrypted modes.
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';
import { deriveAesGcmKey, decryptMeta } from '../crypto.js';

const _dec = new TextDecoder();

function createPatternStream(totalBytes, chunkBytes = 8192) {
  let offset = 0;

  return new ReadableStream({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkBytes, totalBytes - offset);
      const u8 = new Uint8Array(size);
      for (let i = 0; i < size; i++) u8[i] = (offset + i) & 0xff;
      offset += size;
      controller.enqueue(u8);
    },
  });
}

async function drainStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJsonMeta(u8) {
  let obj = null;
  try {
    obj = JSON.parse(_dec.decode(u8));
  } catch {
    throw new Error('FAIL: META is not valid JSON');
  }
  if (!obj || typeof obj !== 'object') throw new Error('FAIL: META is not an object');
  if (obj.v !== 1) throw new Error(`FAIL: META version mismatch (got ${obj.v})`);
  return obj;
}

async function runScenario({ passphrase }) {
  const totalBytes = 64 * 1024 + 7;
  const metaIn = { name: 'hello.txt', type: 'text/plain', size: totalBytes };

  const transportA = new EpheraTransport();
  const transportB = new EpheraTransport();

  transportA.onSend = (data) => transportB._handleIncoming(data);
  transportB.onSend = (data) => transportA._handleIncoming(data);

  await transportA.open();
  await transportB.open();

  const receiver = new EpheraReceiver(transportB);
  const sessionManager = new SessionManager();

  receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
  receiver.start();

  let session = null;
  let metaEvent = null;

  const drains = [];
  let metaTimer = null;
  let metaResolve = null;
  const metaPromise = new Promise((resolve, reject) => {
    metaResolve = resolve;
    metaTimer = setTimeout(() => reject(new Error('FAIL: META not received')), 2000);
  });

  sessionManager.onSession = (s) => {
    session = s;
    s.onMeta = (e) => {
      metaEvent = e;
      if (metaTimer) {
        clearTimeout(metaTimer);
        metaTimer = null;
      }
      if (metaResolve) {
        const r = metaResolve;
        metaResolve = null;
        r(e);
      }
    };
    drains.push(drainStream(s.getStream()));
  };

  const sender = new EpheraSender(transportA, {
    weight: 1,
    passphrase: passphrase || null,
    meta: metaIn,
  });

  await sender.start(createPatternStream(totalBytes));
  await Promise.all(drains);

  // META must be observed during the session.
  await metaPromise;
  if (!metaEvent) throw new Error('FAIL: META not observed on session');

  const flags = (metaEvent.flags || 0) & 0xff;
  if (!(metaEvent.meta instanceof Uint8Array)) {
    throw new Error('FAIL: META payload missing');
  }
  if (!session) throw new Error('FAIL: session missing');

  let metaObj;
  if (passphrase) {
    if ((flags & 0x01) === 0) {
      throw new Error(`FAIL: expected encrypted META flag, got ${flags}`);
    }
    const key = await deriveAesGcmKey(passphrase, session.transferId);
    const pt = await decryptMeta(key, session.transferId, flags, metaEvent.meta);
    metaObj = parseJsonMeta(pt);
  } else {
    if (flags !== 0) {
      throw new Error(`FAIL: expected plaintext META flags=0, got ${flags}`);
    }
    metaObj = parseJsonMeta(metaEvent.meta);
  }

  if (metaObj.name !== metaIn.name) {
    throw new Error(`FAIL: META name mismatch (got ${metaObj.name}, expected ${metaIn.name})`);
  }
  if (metaObj.type !== metaIn.type) {
    throw new Error(`FAIL: META type mismatch (got ${metaObj.type}, expected ${metaIn.type})`);
  }
  if (metaObj.size !== metaIn.size) {
    throw new Error(`FAIL: META size mismatch (got ${metaObj.size}, expected ${metaIn.size})`);
  }

  if (sessionManager.getSessionCount() !== 0) {
    throw new Error(`FAIL: SessionManager not empty (${sessionManager.getSessionCount()})`);
  }

  receiver.destroy();
  sessionManager.destroy();
  transportA.destroy();
  transportB.destroy();
}

export async function runMetadataTest() {
  console.log('--- STARTING METADATA TEST ---');
  await runScenario({ passphrase: null });
  await runScenario({ passphrase: 'meta-passphrase' });
  console.log('--- METADATA TEST PASSED ---');
}
