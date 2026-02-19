/**
 * EPHERA — TransferSession (Stage 3.2, CANONICAL)
 *
 * RESPONSIBILITIES:
 * - Own exactly one transfer lifecycle
 * - Enforce chunk ordering
 * - Expose a single ReadableStream
 * - Isolate aborts
 *
 * GUARANTEES:
 * - O(1) memory
 * - No buffers, arrays, or accumulation
 * - Abort is terminal
 * - Clean END vs Abort are distinct
 */

class TransferSession {
    /**
     * @param {Uint8Array} transferId - MUST be the same reference passed by SessionManager
     */
    constructor(transferId) {
        if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
            throw new Error('Invalid transferId');
        }

        // IMPORTANT: keep reference identity (do NOT clone)
        this.transferId = transferId;

        this.stream = null;
        this.controller = null;

        this.expectedChunkIndex = 0;

        // Optional per-transfer metadata (sent once after START).
        this.metaFlags = 0;
        this.metaBytes = null;

        /**
         * Optional callback invoked on META.
         * ({ flags: number, meta: Uint8Array }) => void
         */
        this.onMeta = null;

        this.started = false;
        this.destroyed = false;
        this.completed = false;
    }

    /**
     * Called exactly once on MSG_START
     */
    handleStart() {
        if (this.started || this.destroyed) return;

        this.started = true;
        this.expectedChunkIndex = 0;

        // Use a byte-based queue strategy to keep buffering bounded.
        // NOTE: This does not provide true backpressure to WebRTC (no pause API),
        // but it prevents unbounded JS-side accumulation if the consumer stalls.
        this.stream = new ReadableStream({
            start: (controller) => {
                this.controller = controller;
            },
            cancel: () => {
                // Consumer cancellation = abort
                this._abort('consumer cancelled');
            },
        }, {
            highWaterMark: 4 * 1024 * 1024,
            size: (chunk) => (chunk && chunk.byteLength) ? chunk.byteLength : 0,
        });
    }

    /**
     * Consumer-facing stream
     */
    getStream() {
        return this.stream;
    }

    /**
     * Handle incoming data chunk
     */
    handleChunk(chunkIndex, payload) {
        if (this.destroyed || !this.started || !this.controller) return;

        if (chunkIndex !== this.expectedChunkIndex) {
            this._abort('chunk order mismatch');
            return;
        }

        // Bounded buffering: if the consumer is not keeping up, abort deterministically.
        const desired = this.controller.desiredSize;
        if (desired !== null && desired !== undefined) {
            const size = payload && payload.byteLength ? payload.byteLength : 0;
            if (desired < size) {
                this._abort('receiver backpressure overflow');
                return;
            }
        }

        try {
            this.controller.enqueue(payload);
            this.expectedChunkIndex++;
        } catch {
            this._abort('enqueue failed');
        }
    }

    /**
     * Handle optional transfer metadata (one-shot, after START).
     */
    handleMeta(flags, metaBytes) {
        if (this.destroyed || !this.started) return;

        if (this.metaBytes) {
            this._abort('duplicate meta');
            return;
        }

        if (!(metaBytes instanceof Uint8Array)) {
            this._abort('invalid meta payload');
            return;
        }

        this.metaFlags = (flags & 0xff) >>> 0;
        this.metaBytes = metaBytes;

        if (this.onMeta) {
            try {
                this.onMeta({ flags: this.metaFlags, meta: metaBytes });
            } catch {
                // Observer failures must never affect transfer lifecycle.
            }
        }
    }

    getMeta() {
        if (!this.metaBytes) return null;
        return { flags: this.metaFlags, meta: this.metaBytes };
    }

    /**
     * Handle clean transfer completion
     */
    handleEnd(totalChunks) {
        if (this.destroyed || !this.started) return;

        if (totalChunks !== this.expectedChunkIndex) {
            this._abort('chunk count mismatch');
            return;
        }

        this.completed = true;
        this._close();
    }

    /**
     * Handle abort (sender abort or channel death)
     */
    handleAbort(reason = 'aborted') {
        if (this.destroyed) return;
        this._abort(reason);
    }

    /**
     * Deterministic teardown (used by SessionManager during full app cleanup).
     * This is an abort, not a clean END.
     */
    destroy() {
        if (this.destroyed) return;
        this._abort('destroyed');
    }

    /* ---------- Internal termination ---------- */

    _close() {
        if (this.destroyed) return;
        this.destroyed = true;

        if (this.controller) {
            try {
                this.controller.close();
            } catch { }
            this.controller = null;
        }

        this._reset();
    }

    _abort(reason) {
        if (this.destroyed) return;
        this.destroyed = true;

        if (this.controller) {
            try {
                this.controller.error(new Error(reason));
            } catch { }
            this.controller = null;
        }

        this._reset();
    }

    _reset() {
        this.stream = null;
        this.started = false;
        this.completed = false;
        this.expectedChunkIndex = 0;
        this.metaFlags = 0;
        this.metaBytes = null;
        this.onMeta = null;
    }
}

export { TransferSession };
