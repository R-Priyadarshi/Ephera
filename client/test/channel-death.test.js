/**
 * EPHERA — Channel Death Test (Stage 3.3)
 * 
 * GOAL:
 * Prove that transport closure aborts ALL active sessions immediately.
 */

import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

class MockTransport {
    constructor() {
        this.onChunk = null;
        this.onClose = null;
        this.onError = null;
    }
    receive(data) { if (this.onChunk) this.onChunk(data); }
    close() { if (this.onClose) this.onClose(); }
}

async function runChannelDeathTest() {
    console.log('--- STARTING CHANNEL DEATH TEST ---');

    const transport = new MockTransport();
    const receiver = new EpheraReceiver(transport);
    const sessionManager = new SessionManager();

    receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);
    receiver.start();

    const statuses = new Map();

    sessionManager.onSession = (session) => {
        const id = session.transferId[0];
        statuses.set(id, 'active');

        const reader = session.getStream().getReader();
        (async () => {
            try {
                while (true) {
                    const { done } = await reader.read();
                    if (done) break;
                }
            } catch (err) {
                statuses.set(id, 'errored');
                console.log(`[Test] Session ${id} detected channel death: ${err.message}`);
            } finally {
                reader.releaseLock();
            }
        })();
    };

    const idA = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const idB = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);

    transport.receive(new Uint8Array([0x01, ...idA])); // START A
    transport.receive(new Uint8Array([0x01, ...idB])); // START B

    if (sessionManager.getSessionCount() !== 2) {
        throw new Error('FAIL: Sessions failed to start');
    }

    // SIMULATE CHANNEL DEATH
    console.log('[Test] Simulating Transport Close...');
    transport.close();

    // SessionManager must be told about the closure via wiring in app.js
    // In our test, we trigger it manually as app.js logic is out of scope for these component tests
    sessionManager.handleClose();

    // Wait for microtasks
    await new Promise(r => setTimeout(r, 100));

    // --- ASSERTIONS ---

    if (statuses.get(1) !== 'errored' || statuses.get(2) !== 'errored') {
        throw new Error('FAIL: Active sessions did not error on channel death');
    }
    if (sessionManager.getSessionCount() !== 0) {
        throw new Error('FAIL: SessionManager did not clear sessions after channel death');
    }

    console.log('--- CHANNEL DEATH TEST PASSED ---');
}

export { runChannelDeathTest };
if (typeof window !== 'undefined') {
    runChannelDeathTest().catch(console.error);
}
