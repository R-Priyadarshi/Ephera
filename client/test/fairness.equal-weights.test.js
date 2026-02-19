/**
 * EPHERA — Fairness: Equal Weights Test (Stage 4, CANONICAL)
 *
 * PURPOSE:
 * Prove that multiple concurrent transfers make fair, interleaved progress
 * when using the real Ephera stack.
 *
 * CRITERIA:
 * - All sessions must complete.
 * - Sessions must interleave (monitored via SessionManager events).
 * - SessionManager must return to zero active sessions.
 * - No starvation occurs.
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

/* ---------- Utilities ---------- */

/**
 * Creates a ReadableStream that enqueues chunks with a small delay to 
 * simulate asynchronous source data and encourage interleaving.
 */
function createTestStream(label, count) {
    let index = 0;
    return new ReadableStream({
        async pull(controller) {
            if (index >= count) {
                controller.close();
                return;
            }

            // Simulate async production
            await new Promise(resolve => {
                // We use a microtask-based delay to stay "event-driven" 
                // without relying on wall-clock timers for logic.
                queueMicrotask(resolve);
            });

            const chunk = new Uint8Array(1);
            chunk[0] = label.charCodeAt(0);
            controller.enqueue(chunk);
            index++;
        }
    });
}

/**
 * Establishment of a local WebRTC connection between two transports.
 */
async function establishLoopback(t1, t2) {
    // Wire transports together (loopback, no WebRTC required for this test)
    t1.onSend = (data) => t2._handleIncoming(data);
    t2.onSend = (data) => t1._handleIncoming(data);

    await t1.open();
    await t2.open();
}

/* ---------- Test Execution ---------- */

export async function runFairnessTest() {
    console.log('--- STARTING FAIRNESS TEST (EQUAL WEIGHTS) ---');

    const transportA = new EpheraTransport();
    const transportB = new EpheraTransport();

    let receiver = null;
    let sessionManager = null;

    try {
        // 1. Establish connection (loopback)
        await establishLoopback(transportA, transportB);
        console.log('[Test] Loopback established.');

        // 2. Setup Receiver Stack
        receiver = new EpheraReceiver(transportB);
        sessionManager = new SessionManager();
        receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
        receiver.start();

        const progress = []; // Record of interleaving
        const completions = new Set();
        const drains = [];
        let readyResolve;
        const ready = new Promise((r) => { readyResolve = r; });

        sessionManager.onSession = (session) => {
            const id = session.transferId;
            const reader = session.getStream().getReader();

            const p = (async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        // Record the label to verify interleaving
                        progress.push(String.fromCharCode(value[0]));
                    }
                    completions.add(id);
                } finally {
                    reader.releaseLock();
                }
            })();

            drains.push(p);
            if (drains.length === 2) readyResolve();
        };

        // 3. Start Concurrent Senders
        // Note: This assumes EpheraTransport/Sender will be updated in Stage 4 
        // to allow this. Under current Stage 3.3, this may throw "Session already active".
        const sender1 = new EpheraSender(transportA);
        const sender2 = new EpheraSender(transportA);

        const stream1 = createTestStream('A', 5);
        const stream2 = createTestStream('B', 5);

        console.log('[Test] Starting concurrent transfers...');

        await Promise.all([
            sender1.start(stream1),
            sender2.start(stream2)
        ]);

        // Wait for both sessions to be observed and drained
        await ready;
        await Promise.all(drains);

        // 4. Verification
        console.log('[Test] Transfers complete.');
        console.log(`[Test] Interleaving pattern: ${progress.join('')}`);

        if (sessionManager.getSessionCount() !== 0) {
            throw new Error(`FAIL: SessionManager leaked sessions. Count: ${sessionManager.getSessionCount()}`);
        }

        if (completions.size !== 2) {
            throw new Error(`FAIL: Expected 2 completions, got ${completions.size}`);
        }

        // Verify interleaving (Fairness)
        // A fair interleaving should not have one session finish 100% before the other starts.
        const firstHalf = progress.slice(0, 5);
        const hasA = firstHalf.includes('A');
        const hasB = firstHalf.includes('B');

        if (!hasA || !hasB) {
            throw new Error('FAIL: No interleaving detected. One session monopolized the channel.');
        }

        console.log('--- FAIRNESS TEST PASSED ---');

    } catch (err) {
        console.error('--- FAIRNESS TEST FAILED ---');
        console.error(err);
        throw err;
    } finally {
        // Cleanup
        if (receiver) receiver.destroy();
        if (sessionManager) sessionManager.destroy();
        transportA.destroy();
        transportB.destroy();
    }
}

/* ---------- Auto-run ---------- */

if (typeof window !== 'undefined') {
    runFairnessTest().catch(() => { });
}
