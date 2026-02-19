/**
 * EPHERA — Scheduler Liveness Test (Stage 4)
 *
 * GOAL:
 * Prove the transport scheduler does not deadlock when one producer's
 * stream read stalls while another producer has sendable frames.
 *
 * This guards against regressions where a single in-flight readPromise
 * can block progress for all other producers.
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

const _dec = new TextDecoder();

function withTimeout(promise, ms, label = 'timeout') {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function createFastStream(totalBytes = 128 * 1024, chunkBytes = 8192) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      // Keep async without relying on wall-clock timing for correctness.
      await new Promise((r) => queueMicrotask(r));

      const size = Math.min(chunkBytes, totalBytes - offset);
      const u8 = new Uint8Array(size);
      for (let i = 0; i < size; i++) u8[i] = (offset + i) & 0xff;
      offset += size;
      controller.enqueue(u8);
    },
  });
}

function createStalledStream() {
  // Never produces data and never closes.
  return new ReadableStream({
    pull() {
      return new Promise(() => {});
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

export async function runSchedulerLivenessTest() {
  console.log('--- STARTING SCHEDULER LIVENESS TEST ---');

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

  let fastDrain = null;
  let fastReadyResolve;
  const fastReady = new Promise((r) => { fastReadyResolve = r; });

  sessionManager.onSession = (session) => {
    session.onMeta = (e) => {
      let obj = null;
      try { obj = JSON.parse(_dec.decode(e.meta)); } catch {}
      if (!obj || obj.v !== 1) return;
      if (obj.name !== 'fast') return;

      if (!fastDrain) {
        fastDrain = drainStream(session.getStream());
        fastReadyResolve();
      }
    };
  };

  const senderStalled = new EpheraSender(transportA, { weight: 1, meta: { name: 'stalled' } });
  const senderFast = new EpheraSender(transportA, { weight: 1, meta: { name: 'fast' } });

  // Start both; do not await the stalled transfer.
  senderStalled.start(createStalledStream()).catch(() => {});
  const fastSend = senderFast.start(createFastStream());

  // Wait for the receiver to observe the "fast" session and start draining it.
  await withTimeout(fastReady, 2000, 'FAIL: fast session not observed');

  // Fast transfer must complete despite the stalled producer.
  await withTimeout(Promise.all([fastSend, fastDrain]), 4000, 'FAIL: scheduler deadlocked (fast did not complete)');

  receiver.destroy();
  sessionManager.destroy();
  transportA.destroy();
  transportB.destroy();

  console.log('--- SCHEDULER LIVENESS TEST PASSED ---');
}

