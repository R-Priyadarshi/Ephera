/**
 * EPHERA — Fairness Test: Weighted Priority (Stage 4)
 *
 * GOAL:
 * Prove that sessions with higher weights make proportionally
 * more progress while lower-weight sessions still progress.
 *
 * This test MUST pass without modifying:
 * - receiver.js
 * - sender.js
 * - transport.js
 * - TransferSession.js
 * - app.js
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

/* ---------- Utilities ---------- */

function makeStream(label, chunks) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i >= chunks) {
                controller.close();
                return;
            }
            controller.enqueue(new Uint8Array([label.charCodeAt(0), i++]));
        },
    });
}

/**
 * Monitors interleaved progress to calculate weight ratios
 */
async function monitorFairness(session, stats) {
    const reader = session.getStream().getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const label = String.fromCharCode(value[0]);
            stats.progress.push(label);
            stats.counts[label] = (stats.counts[label] || 0) + 1;
        }
    } finally {
        reader.releaseLock();
    }
}

/* ---------- Test ---------- */

export async function runWeightedPriorityFairnessTest() {
    console.log('--- FAIRNESS TEST: WEIGHTED PRIORITY ---');

    // Real transport pair (using Stage 4 canonical test pattern)
    const a = new EpheraTransport();
    const b = new EpheraTransport();

    a.onSend = d => b._handleIncoming(d);
    b.onSend = d => a._handleIncoming(d);

    await a.open();
    await b.open();

    // Receiver stack
    const receiver = new EpheraReceiver(b);
    const manager = new SessionManager();

    receiver.onSessionEvent = e => manager.handleEvent(e);
    receiver.start();

    const stats = {
        progress: [],
        counts: {}
    };

    const drains = [];
    let readyResolve;
    const ready = new Promise((r) => { readyResolve = r; });

    manager.onSession = session => {
        const p = monitorFairness(session, stats);
        drains.push(p);
        if (drains.length === 2) readyResolve();
    };

    // Senders with differing weights
    // Note: weights are assigned at session creation in Stage 4
    const senderHigh = new EpheraSender(a, 10); // Weight: 10
    const senderLow = new EpheraSender(a, 1);   // Weight: 1

    console.log('[Test] Starting weighted concurrent transfers (10:1)...');

    // Larger chunk counts to allow ratio to stabilize
    const p1 = senderHigh.start(makeStream('H', 50));
    const p2 = senderLow.start(makeStream('L', 50));

    await Promise.all([p1, p2]);
    await ready;
    await Promise.all(drains);

    // Assertions
    console.log('[Test] Transfers complete.');
    console.log('[Test] Final counts:', stats.counts);

    if (manager.getSessionCount() !== 0) {
        throw new Error('FAIL: SessionManager leaked sessions');
    }

    // Weight Proof: H should have significantly more progress 
    // than L in the first half of the interleaved stream.
    const sampleSize = 20;
    const sample = stats.progress.slice(0, sampleSize);
    const hCount = sample.filter(x => x === 'H').length;
    const lCount = sample.filter(x => x === 'L').length;

    console.log(`[Test] First ${sampleSize} packets: H=${hCount}, L=${lCount}`);

    if (hCount <= lCount) {
        throw new Error('FAIL: Weighted priority not observed (High weight did not lead)');
    }

    if (lCount === 0) {
        throw new Error('FAIL: Starvation detected (Low weight made no progress)');
    }

    // Cleanup
    receiver.destroy();
    manager.destroy();
    a.destroy();
    b.destroy();

    console.log('--- FAIRNESS TEST (WEIGHTED PRIORITY) PASSED ---');
}

/* ---------- Optional Auto-run ---------- */

if (typeof window !== 'undefined') {
    runWeightedPriorityFairnessTest().catch(console.error);
}
