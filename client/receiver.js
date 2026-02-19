/**
 * EPHERA — Receiver Protocol Decoder (CANONICAL)
 *
 * GUARANTEES:
 * - Constant-space decoding (per frame)
 * - No accumulation
 * - No persistence
 * - Decoder does not own per-transfer lifecycle
 *
 * NOTE:
 * - onSessionEvent is a passive observer ONLY:
 *   observer failures must never affect decoding.
 */

// Protocol message types
const MSG_START = 0x01;
const MSG_CHUNK = 0x02;
const MSG_END = 0x03;
const MSG_ABORT = 0x04;
const MSG_META = 0x05;

// Keep META bounded; the sender caps at 2048 bytes (plaintext) + tag.
const MAX_META_BYTES = 4096;

/* ---------- Decode helpers ---------- */

function decodeType(data) {
  return data[0];
}

function decodeTransferId(data) {
  return data.subarray(1, 9);
}

function decodeChunkIndex(data) {
  return (
    (data[9] << 24) |
    (data[10] << 16) |
    (data[11] << 8) |
    data[12]
  ) >>> 0;
}

function decodePayload(data) {
  return data.subarray(13);
}

function decodeMetaFlags(data) {
  return data[9] & 0xff;
}

function decodeMetaLength(data) {
  return ((data[10] << 8) | data[11]) >>> 0;
}

function decodeMetaPayload(data, metaLen) {
  return data.subarray(12, 12 + metaLen);
}

function decodeTotalChunks(data) {
  return (
    (data[9] << 24) |
    (data[10] << 16) |
    (data[11] << 8) |
    data[12]
  ) >>> 0;
}

/* ---------- Receiver ---------- */

class EpheraReceiver {
  constructor(transport) {
    this.transport = transport;

    this.active = false;
    this.destroyed = false;

    // Passive observer ONLY (must not affect logic)
    this.onSessionEvent = null;

    this._handleFrame = this._handleFrame.bind(this);
    this._handleClose = this._handleClose.bind(this);
    this._handleError = this._handleError.bind(this);
  }

  start() {
    if (this.active || this.destroyed) {
      throw new Error('Receiver already started or destroyed');
    }

    this.active = true;
    this._attachTransport();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;

    this._detachTransport();
    this.onSessionEvent = null;
  }

  /* ---------- Protocol decoding ---------- */

  _handleFrame(data) {
    if (this.destroyed) return;

    const frame = data instanceof Uint8Array ? data : new Uint8Array(data);

    if (frame.byteLength < 9) {
      this.destroy();
      return;
    }

    const type = decodeType(frame);
    const transferId = decodeTransferId(frame);

    let event = null;

    switch (type) {
      case MSG_START:
        event = { type, transferId };
        break;

      case MSG_CHUNK:
        if (frame.byteLength < 13) {
          this.destroy();
          return;
        }
        event = {
          type,
          transferId,
          chunkIndex: decodeChunkIndex(frame),
          payload: decodePayload(frame),
        };
        break;

      case MSG_END:
        if (frame.byteLength < 13) {
          this.destroy();
          return;
        }
        event = {
          type,
          transferId,
          totalChunks: decodeTotalChunks(frame),
        };
        break;

      case MSG_ABORT:
        event = { type, transferId };
        break;

      case MSG_META: {
        if (frame.byteLength < 12) {
          this.destroy();
          return;
        }

        const flags = decodeMetaFlags(frame);
        const metaLen = decodeMetaLength(frame);

        if (metaLen > MAX_META_BYTES) {
          this.destroy();
          return;
        }

        // Enforce deterministic framing: metaLen must match remaining bytes exactly.
        if (12 + metaLen !== frame.byteLength) {
          this.destroy();
          return;
        }

        event = {
          type,
          transferId,
          flags,
          meta: decodeMetaPayload(frame, metaLen),
        };
        break;
      }

      default:
        this.destroy();
        return;
    }

    // Passive observer — MUST NOT affect behavior
    if (this.onSessionEvent) {
      try {
        this.onSessionEvent(event);
      } catch {
        // Observer failure must never affect protocol
      }
    }
  }

  /* ---------- Transport lifecycle ---------- */

  _handleClose() {
    this.destroy();
  }

  _handleError() {
    this.destroy();
  }

  _attachTransport() {
    if (!this.transport) return;

    if (typeof this.transport.addEventListener === 'function') {
      this.transport.addEventListener('chunk', this._handleFrame);
      this.transport.addEventListener('close', this._handleClose);
      this.transport.addEventListener('error', this._handleError);
      return;
    }

    // Fallback for MockTransport-style transports
    this.transport.onChunk = this._handleFrame;
    this.transport.onClose = this._handleClose;
    this.transport.onError = this._handleError;
  }

  _detachTransport() {
    if (!this.transport) return;

    if (typeof this.transport.removeEventListener === 'function') {
      this.transport.removeEventListener('chunk', this._handleFrame);
      this.transport.removeEventListener('close', this._handleClose);
      this.transport.removeEventListener('error', this._handleError);
    } else {
      this.transport.onChunk = null;
      this.transport.onClose = null;
      this.transport.onError = null;
    }

    this.transport = null;
  }
}

export { EpheraReceiver, MSG_START, MSG_CHUNK, MSG_END, MSG_ABORT, MSG_META };
