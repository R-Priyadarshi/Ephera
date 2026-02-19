/**
 * EPHERA — SessionManager (Stage 3.2, CANONICAL)
 *
 * RESPONSIBILITIES:
 * - Create TransferSession on MSG_START
 * - Route decoded protocol events by transferId
 * - Own session lifecycle registration & deletion
 * - Abort ALL sessions on channel close
 *
 * GUARANTEES:
 * - O(1) memory per session
 * - No accumulation, buffers, arrays, or queues
 * - No protocol decoding
 * - No transport ownership
 * - No retries, resurrection, or persistence
 */

import { TransferSession } from './TransferSession.js';

// Protocol message types (must match receiver.js)
const MSG_START = 0x01;
const MSG_CHUNK = 0x02;
const MSG_END = 0x03;
const MSG_ABORT = 0x04;
const MSG_META = 0x05;
const RESERVED_TRANSFER_DOMAIN_BIT = 0x80;

function keyHi(transferId) {
    return (
        (transferId[0] << 24) |
        (transferId[1] << 16) |
        (transferId[2] << 8) |
        transferId[3]
    ) >>> 0;
}

function keyLo(transferId) {
    return (
        (transferId[4] << 24) |
        (transferId[5] << 16) |
        (transferId[6] << 8) |
        transferId[7]
    ) >>> 0;
}

class SessionManager {
    constructor() {
        /**
         * Map<number, Map<number, TransferSession>>
         *
         * IMPORTANT:
         * - Routing is by transferId *value*, not reference identity.
         * - No stringification keys (no per-chunk allocations).
         */
        this.sessions = new Map();
        this._count = 0;

        this.destroyed = false;

        /**
         * Optional callback invoked when a new session is created.
         * (Used by app.js / meaning.js)
         *
         * (session: TransferSession) => void
         */
        this.onSession = null;
    }

    /**
     * Entry point for decoded protocol events from receiver.js.
     * This function performs routing ONLY.
     *
     * @param {Object} event
     * @param {number} event.type
     * @param {Uint8Array} event.transferId
     * @param {number} [event.flags]
     * @param {Uint8Array} [event.meta]
     * @param {number} [event.chunkIndex]
     * @param {Uint8Array} [event.payload]
     * @param {number} [event.totalChunks]
     */
    handleEvent(event) {
        if (this.destroyed) return;

        const { type, transferId } = event;

        // Basic sanity check (receiver.js already validates protocol)
        if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
            return;
        }

        // Stage 9 invariant:
        // transferIds with high bit set are reserved for non-session control
        // domains (e.g., passphrase handshake META). They must never create or
        // mutate TransferSession lifecycle.
        if ((transferId[0] & RESERVED_TRANSFER_DOMAIN_BIT) === RESERVED_TRANSFER_DOMAIN_BIT) {
            return;
        }

        const hi = keyHi(transferId);
        const lo = keyLo(transferId);

        switch (type) {
            case MSG_START:
                this._handleStart(hi, lo, transferId);
                break;

            case MSG_CHUNK:
                this._handleChunk(hi, lo, event.chunkIndex, event.payload);
                break;

            case MSG_END:
                this._handleEnd(hi, lo, event.totalChunks);
                break;

            case MSG_ABORT:
                this._handleAbort(hi, lo);
                break;

            case MSG_META:
                this._handleMeta(hi, lo, event.flags, event.meta);
                break;

            default:
                // Unknown types are ignored here.
                // receiver.js handles protocol violations.
                break;
        }
    }

    /**
     * Channel closed or errored.
     * This is a HARD ABORT for all active sessions.
     */
    handleClose() {
        if (this.destroyed) return;

        for (const bucket of this.sessions.values()) {
            for (const session of bucket.values()) {
                // Channel death = forced abort
                session.handleAbort('channel closed');
            }
        }

        this.sessions.clear();
        this._count = 0;
    }

    /**
     * Destroy the SessionManager itself.
     * Used during full app teardown.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        for (const bucket of this.sessions.values()) {
            for (const session of bucket.values()) {
                session.destroy();
            }
        }

        this.sessions.clear();
        this._count = 0;
        this.onSession = null;
    }

    /* ---------- Internal Handlers ---------- */

    _getBucket(hi, create = false) {
        let bucket = this.sessions.get(hi);
        if (!bucket && create) {
            bucket = new Map();
            this.sessions.set(hi, bucket);
        }
        return bucket;
    }

    _getSession(hi, lo) {
        const bucket = this.sessions.get(hi);
        if (!bucket) return null;
        return bucket.get(lo) || null;
    }

    _setSession(hi, lo, session) {
        const bucket = this._getBucket(hi, true);
        bucket.set(lo, session);
        this._count++;
    }

    _deleteSession(hi, lo) {
        const bucket = this.sessions.get(hi);
        if (!bucket) return;

        if (bucket.delete(lo)) {
            this._count--;
        }

        if (bucket.size === 0) {
            this.sessions.delete(hi);
        }
    }

    _handleStart(hi, lo, transferId) {
        // Ignore duplicate START for same transferId
        if (this._getSession(hi, lo)) return;

        const session = new TransferSession(transferId);
        this._setSession(hi, lo, session);

        session.handleStart();

        if (this.onSession) {
            this.onSession(session);
        }
    }

    _handleChunk(hi, lo, chunkIndex, payload) {
        const session = this._getSession(hi, lo);
        if (!session) return;

        session.handleChunk(chunkIndex, payload);

        // If the session self-aborted due to an invariant violation,
        // it must be deleted immediately to avoid leaks.
        if (session.destroyed) {
            this._deleteSession(hi, lo);
        }
    }

    _handleEnd(hi, lo, totalChunks) {
        const session = this._getSession(hi, lo);
        if (!session) return;

        session.handleEnd(totalChunks);

        // END is terminal — SessionManager owns deletion
        this._deleteSession(hi, lo);
    }

    _handleAbort(hi, lo) {
        const session = this._getSession(hi, lo);
        if (!session) return;

        session.handleAbort('aborted by sender');

        // ABORT is terminal — SessionManager owns deletion
        this._deleteSession(hi, lo);
    }

    _handleMeta(hi, lo, flags, meta) {
        const session = this._getSession(hi, lo);
        if (!session) return;

        session.handleMeta(flags, meta);

        if (session.destroyed) {
            this._deleteSession(hi, lo);
        }
    }

    /**
     * For diagnostics only (must not be used for logic).
     */
    getSessionCount() {
        return this._count;
    }
}

export {
    SessionManager,
    MSG_START,
    MSG_CHUNK,
    MSG_END,
    MSG_ABORT,
    MSG_META,
};
