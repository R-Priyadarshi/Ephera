/**
 * EPHERA — Concurrency Test (Stage 3.3, CANONICAL)
 *
 * PURPOSE:
 * Prove that multiple real transfers can run concurrently
 * through the full Ephera stack:
 *
 *   EpheraSender
 *     → EpheraTransport
 *       → EpheraReceiver
 *         → SessionManager
 *           → TransferSession
 *
 * WITHOUT:
 * - mocking transport
 * - mocking protocol
 * - buffering payloads
 * - timing hacks
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

/**
 * Utility: create a small readable stream with N chunks.
 * No buffering. Chunks are generated on demand.
 */
function createTestStream(label, chunks) {
    let index = 0;

    return new ReadableStream({
        pull(controller) {
            if (index >= chunks) {
                controller.close();
                return;
            }
            controller.enqueue(
                new Uint8Array([label.charCodeAt(0), index])
            );
            index++;
        },
    });
}

/**
 * Utility: consume a stream fully without buffering.
 * Resolves when stream completes, rejects on error.
 */
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

/**
 * Main concurrency test
 */
export async function runConcurrencyTest() {
    console.log('--- STARTING CONCURRENCY TEST (REAL STACK) ---');

    /* ---------- Transport Pair (Loopback) ---------- */

    const transportA = new EpheraTransport();
    const transportB = new EpheraTransport();

    // Wire transports together (loopback, no signaling server)
    transportA.onSend = (data) => transportB._handleIncoming(data);
    transportB.onSend = (data) => transportA._handleIncoming(data);

    await transportA.open();
    await transportB.open();

    /* ---------- Receiver + SessionManager ---------- */

    const receiver = new EpheraReceiver(transportB);
    const sessionManager = new SessionManager();

    receiver.onSessionEvent = (event) =>
        sessionManager.handleEvent(event);

    receiver.start();

    /* ---------- Track completion ---------- */

    let completedSessions = 0;
    const completionPromises = [];

    sessionManager.onSession = (session) => {
        const p = drainStream(session.getStream()).then(() => {
            completedSessions++;
        });
        completionPromises.push(p);
    };

    /* ---------- Concurrent Senders ---------- */

    const sender1 = new EpheraSender(transportA);
    const sender2 = new EpheraSender(transportA);
    const sender3 = new EpheraSender(transportA);

    const stream1 = createTestStream('A', 5);
    const stream2 = createTestStream('B', 5);
    const stream3 = createTestStream('C', 5);

    // Start all transfers concurrently
    const sendPromises = [
        sender1.start(stream1),
        sender2.start(stream2),
        sender3.start(stream3),
    ];

    /* ---------- Await completion ---------- */

    await Promise.all(sendPromises);
    await Promise.all(completionPromises);

    /* ---------- Assertions ---------- */

    if (completedSessions !== 3) {
        throw new Error(
            `FAIL: Expected 3 completed sessions, got ${completedSessions}`
        );
    }

    if (sessionManager.getSessionCount() !== 0) {
        throw new Error(
            `FAIL: SessionManager not empty (${sessionManager.getSessionCount()})`
        );
    }

    /* ---------- Cleanup ---------- */

    receiver.destroy();
    sessionManager.destroy();
    transportA.destroy();
    transportB.destroy();

    console.log('--- CONCURRENCY TEST PASSED ---');
}

/* ---------- Optional auto-run ---------- */

if (typeof window !== 'undefined') {
    runConcurrencyTest().catch(console.error);
}
