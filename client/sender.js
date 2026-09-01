/**
 * EPHERA — Sender Stream Adapter (Canonical)
 *
 * ZERO-MEMORY GUARANTEES:
 * - Streaming only
 * - No accumulation
 * - No persistence
 * - Single-path deterministic teardown
 *
 * PROTOCOL:
 * - START message → CHUNK messages → END message
 * - ABORT message on any failure
 * - Each message tagged with transferId
 * - Chunks indexed for ordering verification
 */

import {
  sanitizePassphrase,
  deriveAesGcmKey,
  encryptChunk,
  encryptMeta,
  GCM_TAG_BYTES,
} from './crypto.js';

// Protocol message types
const MSG_START = 0x01;
const MSG_CHUNK = 0x02;
const MSG_END = 0x03;
const MSG_ABORT = 0x04;
const MSG_META = 0x05;

// META flags
const META_FLAG_ENCRYPTED = 0x01;

// Keep protocol frames bounded (transport must not split frames).
// We cap CHUNK payload so each encoded frame stays ~64KB.
const MAX_FRAME_BYTES = 64 * 1024;
const CHUNK_HEADER_BYTES = 13;
const MAX_CHUNK_PAYLOAD_BYTES = MAX_FRAME_BYTES - CHUNK_HEADER_BYTES;

// META frame: [type(1)] [transferId(8)] [flags(1)] [metaLen(2)] [metaPayload(metaLen)]
const META_HEADER_BYTES = 12;
const MAX_META_PLAINTEXT_BYTES = 2048;

const _enc = new TextEncoder();

function createTransferTerminationError(reason) {
  const err = new Error(
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : 'Transfer cancelled'
  );
  err.name = 'AbortError';
  err.code = 'EPHERA_TRANSFER_CANCELLED';
  return err;
}

// Generate unique transfer ID (8 bytes)
function generateTransferId() {
  const id = new Uint8Array(8);
  crypto.getRandomValues(id);
  // Reserve transferIds with the high bit set for non-transfer control domains
  // (e.g., encrypted handshake META frames). This guarantees disjoint ID spaces.
  id[0] &= 0x7f;
  return id;
}

// Encode START message: [type(1)] [transferId(8)]
function encodeStart(transferId) {
  const msg = new Uint8Array(9);
  msg[0] = MSG_START;
  msg.set(transferId, 1);
  return msg;
}

// Encode CHUNK message: [type(1)] [transferId(8)] [chunkIndex(4)] [payload]
function encodeChunk(transferId, chunkIndex, payload) {
  const msg = new Uint8Array(13 + payload.byteLength);
  msg[0] = MSG_CHUNK;
  msg.set(transferId, 1);
  msg[9] = (chunkIndex >>> 24) & 0xff;
  msg[10] = (chunkIndex >>> 16) & 0xff;
  msg[11] = (chunkIndex >>> 8) & 0xff;
  msg[12] = chunkIndex & 0xff;
  msg.set(payload, 13);
  return msg;
}

// Encode END message: [type(1)] [transferId(8)] [totalChunks(4)]
function encodeEnd(transferId, totalChunks) {
  const msg = new Uint8Array(13);
  msg[0] = MSG_END;
  msg.set(transferId, 1);
  msg[9] = (totalChunks >>> 24) & 0xff;
  msg[10] = (totalChunks >>> 16) & 0xff;
  msg[11] = (totalChunks >>> 8) & 0xff;
  msg[12] = totalChunks & 0xff;
  return msg;
}

// Encode ABORT message: [type(1)] [transferId(8)]
function encodeAbort(transferId) {
  const msg = new Uint8Array(9);
  msg[0] = MSG_ABORT;
  msg.set(transferId, 1);
  return msg;
}

function sanitizeMeta(value) {
  if (!value || typeof value !== 'object') return null;

  const out = { v: 1 };

  if (typeof value.name === 'string') {
    const n = value.name.trim();
    if (n) out.name = n.slice(0, 256);
  }

  if (typeof value.type === 'string') {
    const t = value.type.trim();
    if (t) out.type = t.slice(0, 128);
  }

  if (Number.isFinite(value.size) && value.size >= 0) {
    out.size = Math.floor(value.size);
  }

  if (typeof value.path === 'string') {
    const p = value.path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    if (p && p !== '.' && p !== '..') out.path = p.slice(0, 768);
  }

  if (!out.name && !out.type && !Number.isFinite(out.size) && !out.path) return null;
  return out;
}

function encodeMeta(transferId, flags, metaPayload) {
  const payload = metaPayload instanceof Uint8Array ? metaPayload : new Uint8Array(metaPayload);
  const len = payload.byteLength;

  if (len > 0xffff) throw new Error('META payload too large');
  if (META_HEADER_BYTES + len > MAX_FRAME_BYTES) throw new Error('META frame too large');

  const msg = new Uint8Array(META_HEADER_BYTES + len);
  msg[0] = MSG_META;
  msg.set(transferId, 1);
  msg[9] = flags & 0xff;
  msg[10] = (len >>> 8) & 0xff;
  msg[11] = len & 0xff;
  msg.set(payload, 12);
  return msg;
}

class EpheraSender {
  constructor(transport, weightOrOptions = 1, maybeOptions = null) {
    this.transport = transport;

    let weight = 1;
    let passphrase = null;
    let kdfIterations = null;
    let meta = null;

    if (weightOrOptions && typeof weightOrOptions === 'object') {
      weight = weightOrOptions.weight;
      passphrase = weightOrOptions.passphrase ?? null;
      kdfIterations = weightOrOptions.kdfIterations ?? null;
      meta = weightOrOptions.meta ?? null;
    } else {
      weight = weightOrOptions;
      if (maybeOptions && typeof maybeOptions === 'object') {
        passphrase = maybeOptions.passphrase ?? null;
        kdfIterations = maybeOptions.kdfIterations ?? null;
        meta = maybeOptions.meta ?? null;
      }
    }

    this.weight = Number.isFinite(weight) ? Math.max(1, Math.floor(weight)) : 1;

    // Stage 6: optional app-layer encryption (passphrase-derived)
    this.passphrase = sanitizePassphrase(passphrase);
    this.kdfIterations = Number.isFinite(kdfIterations) ? Math.max(10_000, Math.floor(kdfIterations)) : null;
    this._aesKey = null;

    // Optional metadata (e.g. filename, mime, size). Serialized once; sent after START.
    this._metaObj = sanitizeMeta(meta);
    this._metaPlain = null;

    this.stream = null;
    this._inputReader = null;
    this.transferId = null;
    this.chunkIndex = 0;

    // Track if transfer completed normally (END sent)
    this.completed = false;

    this.active = false;
    this.destroyed = false;
    this.cancelReason = '';
    this._suppressAbort = false;

    this._handleClose = this._handleClose.bind(this);
    this._handleError = this._handleError.bind(this);
  }

  async start(readableStream) {
    if (this.active || this.destroyed) {
      throw new Error('Sender already started or destroyed');
    }

    if (!readableStream || typeof readableStream.getReader !== 'function') {
      throw new Error('Valid ReadableStream required');
    }

    this.active = true;
    this.stream = readableStream;
    this.transferId = generateTransferId();
    this.chunkIndex = 0;
    this.completed = false;

    // Serialize metadata once per transfer (small, bounded).
    if (this._metaObj) {
      let json = null;
      try {
        const m = this._metaObj;
        json = JSON.stringify({
          v: 1,
          ...(m.name ? { name: m.name } : null),
          ...(m.type ? { type: m.type } : null),
          ...(Number.isFinite(m.size) ? { size: m.size } : null),
          ...(m.path ? { path: m.path } : null),
        });
      } catch {}

      if (json) {
        const bytes = _enc.encode(json);
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_META_PLAINTEXT_BYTES) {
          this._metaPlain = bytes;
        }
      }
    }

    this._attachTransport();

    try {
      if (this.passphrase) {
        // Derive once per transfer (salt = transferId)
        this._aesKey = await deriveAesGcmKey(this.passphrase, this.transferId, {
          ...(this.kdfIterations ? { iterations: this.kdfIterations } : null),
        });
      }
      const protocolStream = this._wrapWithProtocol(this.stream);
      await this.transport.sendStream(protocolStream, { weight: this.weight });
      // Mark as completed only if sendStream finishes without error
      this.completed = true;
    } finally {
      this.destroy();
    }
  }

  cancel(reason = 'Transfer cancelled', { notifyPeer = true } = {}) {
    if (this.completed || this.destroyed) return;
    this.cancelReason = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : 'Transfer cancelled';
    this._suppressAbort = notifyPeer === false;
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;

    // Send ABORT if transfer started but did not complete normally
    if (this.transferId && !this.completed && !this._suppressAbort) {
      this._sendAbort();
    }

    this._detachTransport();

    // Cancel the input stream only on abnormal termination.
    // On clean completion, the protocol wrapper releases the reader lock.
    if (!this.completed) {
      if (this._inputReader) {
        try {
          const p = this._inputReader.cancel();
          if (p && typeof p.catch === 'function') p.catch(() => { });
        } catch {}
        try { this._inputReader.releaseLock(); } catch {}
        this._inputReader = null;
      } else if (this.stream) {
        try {
          const p = this.stream.cancel();
          if (p && typeof p.catch === 'function') p.catch(() => { });
        } catch {}
      }
    }

    this.stream = null;
    this._inputReader = null;

    // Clear protocol state
    this.transferId = null;
    this.chunkIndex = 0;
    this.completed = false;

    // Clear crypto state
    this._aesKey = null;
    this.passphrase = null;
    this.kdfIterations = null;

    // Clear meta state
    this._metaObj = null;
    this._metaPlain = null;
  }

  /* ---------- Abort Handling ---------- */

  _sendAbort() {
    // Best-effort abort — fire and forget, never throws
    if (!this.transport) return;
    try {
      const frame = encodeAbort(this.transferId);

      // Prefer transport.send (respects backpressure) if available.
      if (typeof this.transport.send === 'function') {
        // Do not await during teardown.
        this.transport.send(frame).catch(() => { });
        return;
      }

      if (!this.transport.channel) return;
      if (this.transport.channel.readyState !== 'open') return;
      this.transport.channel.send(frame);
    } catch {}
  }

  /* ---------- Protocol Encoding ---------- */

  _wrapWithProtocol(inputStream) {
    const self = this;
    const transferId = this.transferId;
    let reader = null;
    let startSent = false;
    let metaSent = false;
    let pending = null;
    let pendingOffset = 0;

    const stopIfTerminated = (controller) => {
      if (!self.destroyed) return false;
      try {
        controller.error(createTransferTerminationError(self.cancelReason));
      } catch {}
      return true;
    };

    return new ReadableStream({
      async start() {
        reader = inputStream.getReader();
        self._inputReader = reader;
      },

      async pull(controller) {
        if (stopIfTerminated(controller)) return;

        const maxPlainBytes = self._aesKey
          ? (MAX_CHUNK_PAYLOAD_BYTES - GCM_TAG_BYTES)
          : MAX_CHUNK_PAYLOAD_BYTES;

        // Send START message first
        if (!startSent) {
          controller.enqueue(encodeStart(transferId));
          startSent = true;
          return;
        }

        // Send META exactly once (optional) after START and before any CHUNK.
        if (!metaSent) {
          metaSent = true;
          if (self._metaPlain) {
            let flags = 0;
            let payload = self._metaPlain;

            if (self._aesKey) {
              flags |= META_FLAG_ENCRYPTED;
              try {
                payload = await encryptMeta(self._aesKey, transferId, flags, payload);
              } catch (err) {
                try { controller.error(err); } catch {}
                return;
              }
            }

            if (stopIfTerminated(controller)) return;

            try {
              controller.enqueue(encodeMeta(transferId, flags, payload));
            } catch (err) {
              try { controller.error(err); } catch {}
            }
            return;
          }
        }

        // If we have pending bytes from a previously-read source chunk,
        // emit the next slice without reading more.
        if (pending) {
          const end = Math.min(
            pendingOffset + maxPlainBytes,
            pending.byteLength
          );
          const slice = pending.subarray(pendingOffset, end);
          const idx = self.chunkIndex;

          let payload = slice;
          if (self._aesKey) {
            try {
              payload = await encryptChunk(self._aesKey, transferId, idx, slice);
            } catch (err) {
              try { controller.error(err); } catch {}
              return;
            }
          }

          if (stopIfTerminated(controller)) return;

          controller.enqueue(encodeChunk(transferId, idx, payload));
          self.chunkIndex++;

          pendingOffset = end;
          if (pendingOffset >= pending.byteLength) {
            pending = null;
            pendingOffset = 0;
          }
          return;
        }

        // Read next chunk from source
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (stopIfTerminated(controller)) {
            try { reader.releaseLock(); } catch {}
            reader = null;
            self._inputReader = null;
            return;
          }
          // Propagate input stream error as a protocol stream error.
          try { controller.error(err); } catch {}
          try { reader.releaseLock(); } catch {}
          reader = null;
          self._inputReader = null;
          return;
        }

        if (stopIfTerminated(controller)) return;

        const { done, value } = readResult;

        if (done) {
          // Send END message — marks successful completion
          controller.enqueue(encodeEnd(transferId, self.chunkIndex));
          controller.close();
          try { reader.releaseLock(); } catch {}
          reader = null;
          self._inputReader = null;
          return;
        }

        // Normalize the source chunk, then emit its first slice.
        pending = value instanceof Uint8Array ? value : new Uint8Array(value);
        pendingOffset = 0;

        const end = Math.min(maxPlainBytes, pending.byteLength);
        const slice = pending.subarray(0, end);
        const idx = self.chunkIndex;

        let payload = slice;
        if (self._aesKey) {
          try {
            payload = await encryptChunk(self._aesKey, transferId, idx, slice);
          } catch (err) {
            try { controller.error(err); } catch {}
            try { reader.releaseLock(); } catch {}
            reader = null;
            self._inputReader = null;
            return;
          }
        }

        if (stopIfTerminated(controller)) return;

        controller.enqueue(encodeChunk(transferId, idx, payload));
        self.chunkIndex++;

        pendingOffset = end;
        if (pendingOffset >= pending.byteLength) {
          pending = null;
          pendingOffset = 0;
        }
      },

      cancel() {
        if (reader) {
          try {
            const p = reader.cancel();
            if (p && typeof p.catch === 'function') p.catch(() => { });
            reader.releaseLock();
          } catch {}
          reader = null;
          self._inputReader = null;
        }
      },
    });
  }

  /* ---------- Internal handlers ---------- */

  // Transport close = implicit abort
  _handleClose() {
    this.destroy();
  }

  // Transport error = implicit abort
  _handleError() {
    this.destroy();
  }

  _attachTransport() {
    if (!this.transport) return;

    if (typeof this.transport.addEventListener === 'function') {
      this.transport.addEventListener('close', this._handleClose);
      this.transport.addEventListener('error', this._handleError);
      return;
    }

    // Fallback for MockTransport-style transports
    this.transport.onClose = this._handleClose;
    this.transport.onError = this._handleError;
  }

  _detachTransport() {
    if (!this.transport) return;

    if (typeof this.transport.removeEventListener === 'function') {
      this.transport.removeEventListener('close', this._handleClose);
      this.transport.removeEventListener('error', this._handleError);
    } else {
      this.transport.onClose = null;
      this.transport.onError = null;
    }
    this.transport = null;
  }
}

export { EpheraSender, MSG_START, MSG_CHUNK, MSG_END, MSG_ABORT, MSG_META };
