/**
 * EPHERA — Transport Backpressure Test
 *
 * PURPOSE:
 * Validate that `EpheraTransport.send()`:
 * - waits when `channel.bufferedAmount` is above the high watermark
 * - resumes when `onbufferedamountlow` fires
 * - unblocks and fails deterministically on `destroy()`
 *
 * This is a regression test for Stage 2.1 backpressure correctness and Stage 4
 * send serialization invariants.
 */

import { EpheraTransport } from '../transport.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runTransportBackpressureTest() {
  console.log('--- STARTING TRANSPORT BACKPRESSURE TEST ---');

  const transport = new EpheraTransport(null, []);

  const sent = [];

  // Fake RTCDataChannel surface used by transport.js.
  transport.channel = {
    readyState: 'open',
    bufferedAmount: 1024 * 1024 * 1024, // force "buffer full"
    bufferedAmountLowThreshold: 0,
    binaryType: 'arraybuffer',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    onbufferedamountlow: null,
    close: () => {
      transport.channel.readyState = 'closed';
    },
    send: (frame) => {
      sent.push(frame);
    },
  };

  // Bind the channel callbacks (including onbufferedamountlow -> resume).
  transport._bindChannel();

  const frame = new Uint8Array([1, 2, 3]);
  const p = transport.send(frame);

  // Ensure it is actually waiting for backpressure (should not send immediately).
  await sleep(50);
  if (sent.length !== 0) {
    throw new Error(`FAIL: expected 0 sends while backpressured, got ${sent.length}`);
  }

  // Drain buffer and signal low-watermark event.
  transport.channel.bufferedAmount = 0;
  if (typeof transport.channel.onbufferedamountlow === 'function') {
    transport.channel.onbufferedamountlow();
  } else {
    throw new Error('FAIL: onbufferedamountlow not bound');
  }

  await p;

  if (sent.length !== 1) {
    throw new Error(`FAIL: expected 1 send after resume, got ${sent.length}`);
  }

  // Destroy must unblock any waiting send and fail deterministically.
  transport.channel.bufferedAmount = 1024 * 1024 * 1024;
  const p2 = transport.send(new Uint8Array([9]));
  await sleep(20);
  transport.destroy();

  let ok = false;
  try {
    await p2;
  } catch (err) {
    ok = true;
  }

  if (!ok) {
    throw new Error('FAIL: expected send to reject after destroy() while waiting');
  }

  console.log('--- TRANSPORT BACKPRESSURE TEST PASSED ---');
}

if (typeof window !== 'undefined') {
  runTransportBackpressureTest().catch(console.error);
}

