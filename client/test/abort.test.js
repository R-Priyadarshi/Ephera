/**
 * EPHERA — Abort Isolation Test (Stage 3.3, CANONICAL)
 *
 * PURPOSE:
 * Prove that aborting one real transfer does NOT:
 * - affect other concurrent transfers
 * - close the transport
 * - leak sessions
 */

import { EpheraTransport } from '../transport.js';
import { EpheraSender } from '../sender.js';
import { EpheraReceiver } from '../receiver.js';
import { SessionManager } from '../session/SessionManager.js';

/* ---------- Utilities ---------- */

function createTestStream(label, totalChunks, abortAt = null) {
    let index = 0;

    return new ReadableStream({
        pull(controller) {
            if (abortAt !== null && index === abortAt) {
                controller.error(new Error('intentional abort'));
                return;
            }

            if (index >= totalChunks) {
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

async function assertSenderCancellationRaceIsSafe() {
    const sentFrameTypes = [];
    let sawStartResolve;
    const sawStart = new Promise((resolve) => {
        sawStartResolve = resolve;
    });

    const mockTransport = {
        addEventListener() {},
        removeEventListener() {},
        async send() {},
        async sendStream(stream) {
            const reader = stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) return;
                    sentFrameTypes.push(value[0]);
                    if (value[0] === 0x01) sawStartResolve();
                }
            } finally {
                try { reader.releaseLock(); } catch {}
            }
        },
    };

    let produced = false;
    const delayedSource = new ReadableStream({
        async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            if (produced) {
                controller.close();
                return;
            }
            produced = true;
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
    });

    const sender = new EpheraSender(mockTransport);
    const resultPromise = sender.start(delayedSource).then(
        () => null,
        (err) => err
    );

    await sawStart;
    sender.cancel('Receiver cancelled transfer', { notifyPeer: false });
    const result = await resultPromise;

    if (!result || result.code !== 'EPHERA_TRANSFER_CANCELLED') {
        throw new Error(`FAIL: Expected controlled cancellation error, got ${result && result.message}`);
    }
    if (/undefined|null|convert/i.test(String(result.message || ''))) {
        throw new Error(`FAIL: Cancellation leaked an internal state error: ${result.message}`);
    }
    if (sentFrameTypes.includes(0x03)) {
        throw new Error('FAIL: Cancelled sender emitted an END frame');
    }
}

/* ---------- Abort Isolation Test ---------- */

export async function runAbortTest() {
    console.log('--- STARTING ABORT ISOLATION TEST (REAL STACK) ---');

    /* ---------- Transport Pair ---------- */

    const transportA = new EpheraTransport();
    const transportB = new EpheraTransport();

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

    /* ---------- Track Outcomes ---------- */

    let completed = 0;
    let aborted = 0;

    sessionManager.onSession = (session) => {
        drainStream(session.getStream())
            .then(() => {
                completed++;
            })
            .catch(() => {
                aborted++;
            });
    };

    /* ---------- Senders ---------- */

    const senderA = new EpheraSender(transportA);
    const senderB = new EpheraSender(transportA);

    const streamA = createTestStream('A', 5, 2); // abort mid-way
    const streamB = createTestStream('B', 5);    // completes normally

    /* ---------- Start Transfers Concurrently ---------- */

    const pA = senderA.start(streamA).catch(() => { });
    const pB = senderB.start(streamB);

    await Promise.allSettled([pA, pB]);

    /* ---------- Assertions ---------- */

    if (aborted !== 1) {
        throw new Error(
            `FAIL: Expected 1 aborted session, got ${aborted}`
        );
    }

    if (completed !== 1) {
        throw new Error(
            `FAIL: Expected 1 completed session, got ${completed}`
        );
    }

    if (sessionManager.getSessionCount() !== 0) {
        throw new Error(
            `FAIL: SessionManager leaked sessions (${sessionManager.getSessionCount()})`
        );
    }

    await assertSenderCancellationRaceIsSafe();

    /* ---------- Cleanup ---------- */

    receiver.destroy();
    sessionManager.destroy();
    transportA.destroy();
    transportB.destroy();

    console.log('--- ABORT ISOLATION TEST PASSED ---');
}

/* ---------- Optional Auto-run ---------- */

if (typeof window !== 'undefined') {
    runAbortTest().catch(console.error);
}
