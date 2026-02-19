/**
 * EPHERA — Encryption Test: Passphrase Mode (Stage 6)
 *
 * GOAL:
 * Prove app-layer encryption works end-to-end without buffering:
 *
 * Sender (AES-GCM per protocol chunk) -> Transport -> Receiver -> Session stream (ciphertext)
 *   -> decrypt in consumer -> verify plaintext bytes match expected stream
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';
import { deriveAesGcmKey, decryptChunk } from '../crypto.js';

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
      for (let i = 0; i < size; i++) {
        u8[i] = (offset + i) & 0xff;
      }

      offset += size;
      controller.enqueue(u8);
    },
  });
}

async function drainDecryptAndVerify(session, passphrase, totalBytes) {
  const stream = session.getStream();
  if (!stream) throw new Error('Missing session stream');

  const key = await deriveAesGcmKey(passphrase, session.transferId);
  const reader = stream.getReader();

  let chunkIndex = 0;
  let offset = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const ct = value instanceof Uint8Array ? value : new Uint8Array(value);
      const pt = await decryptChunk(key, session.transferId, chunkIndex, ct);
      chunkIndex++;

      for (let i = 0; i < pt.length; i++) {
        const expected = offset & 0xff;
        if (pt[i] !== expected) {
          throw new Error(`FAIL: plaintext mismatch at offset ${offset} (got ${pt[i]}, expected ${expected})`);
        }
        offset++;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (offset !== totalBytes) {
    throw new Error(`FAIL: plaintext length mismatch (got ${offset}, expected ${totalBytes})`);
  }
}

export async function runPassphraseEncryptionTest() {
  console.log('--- STARTING ENCRYPTION TEST (PASSPHRASE) ---');

  const passphrase = 'correct horse battery staple';
  const totalBytes = 256 * 1024 + 123;

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

  const drains = [];
  sessionManager.onSession = (session) => {
    drains.push(drainDecryptAndVerify(session, passphrase, totalBytes));
  };

  const sender = new EpheraSender(transportA, { weight: 1, passphrase });
  const stream = createPatternStream(totalBytes);

  await sender.start(stream);
  await Promise.all(drains);

  if (sessionManager.getSessionCount() !== 0) {
    throw new Error(`FAIL: SessionManager not empty (${sessionManager.getSessionCount()})`);
  }

  receiver.destroy();
  sessionManager.destroy();
  transportA.destroy();
  transportB.destroy();

  console.log('--- ENCRYPTION TEST (PASSPHRASE) PASSED ---');
}

