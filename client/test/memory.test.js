/**
 * EPHERA — Memory Safety Test (Stage 3.3)
 * 
 * GOAL:
 * Prove that no TransferSession or stream references are leaked after teardown.
 * 
 * NOTE: 
 * True memory leak detection requires Heap Snapshots.
 * This test uses WeakRef and sequential execution counts.
 */

import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

class MockTransport {
    constructor() { this.onChunk = null; }
    receive(data) { if (this.onChunk) this.onChunk(data); }
}

async function runMemoryTest() {
    console.log('--- STARTING MEMORY SAFETY TEST ---');

    const transport = new MockTransport();
    const receiver = new EpheraReceiver(transport);
    const sessionManager = new SessionManager();

    receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
    receiver.start();

    const ITERATIONS = 1000;
    console.log(`[Test] Running ${ITERATIONS} sequential transfers...`);

    // IMPORTANT:
    // Create sessions inside a nested scope so V8 can prove they are dead.
    // (GC liveness in the same frame can keep objects alive even if they are only weakly referenced.)
    const refs = (() => {
        const refs = []; // Array of WeakRefs to sessions

        for (let i = 0; i < ITERATIONS; i++) {
            const id = new Uint8Array(8);
            crypto.getRandomValues(id);

            // Capture the session via WeakRef (must not retain a strong reference).
            sessionManager.onSession = (s) => {
                if (typeof WeakRef !== 'undefined') {
                    refs.push(new WeakRef(s));
                }
            };

            // START -> CHUNK -> END
            transport.receive(new Uint8Array([0x01, ...id]));
            transport.receive(new Uint8Array([0x02, ...id, 0, 0, 0, 0, 0xAA])); // 1-byte payload
            transport.receive(new Uint8Array([0x03, ...id, 0, 0, 0, 1])); // END total=1

            if (sessionManager.getSessionCount() !== 0) {
                throw new Error(`FAIL: Session leaked in Map at iteration ${i}`);
            }
        }

        return refs;
    })();

    // Ensure the last callback doesn't keep any incidental references alive.
    sessionManager.onSession = null;

    console.log(`[Test] Completed ${ITERATIONS} transfers. Map size is 0.`);

    if (typeof WeakRef !== 'undefined') {
        console.log('[Test] WeakRef support detected. Checking for collection...');

        const canForceGc = typeof globalThis.gc === 'function';
        if (!canForceGc) {
            console.log('[Manual Step] Run this test with Node flag: --expose-gc');
            console.log('[Manual Step] Or verify in Chrome DevTools -> Memory -> Heap Snapshot (TransferSession count returns to 0).');
        } else {
            const deadlineMs = 5000;
            const deadline = Date.now() + deadlineMs;

            // IMPORTANT:
            // Avoid calling GC immediately after deref() scans.
            // V8 can keep deref() results alive on-stack until the next turn,
            // which will make GC think targets are still strongly reachable.
            const gcCyclesPerRound = 20;

            let alive = refs.filter(r => r.deref() !== undefined).length;
            while (alive !== 0 && Date.now() < deadline) {
                for (let i = 0; i < gcCyclesPerRound; i++) {
                    globalThis.gc();
                    await new Promise((r) => setTimeout(r, 0));
                }

                alive = refs.filter(r => r.deref() !== undefined).length;
                await new Promise((r) => setTimeout(r, 0));
            }

            if (alive !== 0) {
                throw new Error(`FAIL: ${alive} / ${ITERATIONS} sessions still reachable after forced GC`);
            }
            console.log('--- MEMORY SAFETY TEST PASSED (GC) ---');
        }
    }

    console.log('--- MEMORY SAFETY TEST FINISHED ---');
}

export { runMemoryTest };
if (typeof window !== 'undefined') {
    runMemoryTest().catch(console.error);
}
