/**
 * EPHERA — Meaning-First Signaling (Canonical)
 *
 * ZERO-MEMORY GUARANTEES:
 * - One-shot delivery
 * - No retention
 * - No accumulation
 * - No persistence
 * - Advisory only
 */

const MAX_LEN = 64;
const CATEGORIES = new Set([
  'document',
  'image',
  'audio',
  'video',
  'archive',
  'other',
]);

function sanitize(value) {
  if (typeof value !== 'string') return null;
  return value.slice(0, MAX_LEN);
}

function sanitizeCategory(value) {
  if (!CATEGORIES.has(value)) return null;
  return value;
}

/* ---------------- Sender ---------------- */

class MeaningSender {
  constructor(sendFn) {
    this.sendFn = sendFn;
    this.sent = false;
    this.destroyed = false;
  }

  send({ mimeHint = null, category = null, sizeRange = null }) {
    if (this.destroyed || this.sent) return;

    const payload = {
      mimeHint: sanitize(mimeHint),
      category: sanitizeCategory(category),
      sizeRange: sanitize(sizeRange),
    };

    if (this.sendFn) {
      this.sendFn(payload);
    }

    this.sent = true;
    this.destroy();
  }

  destroy() {
    this.sendFn = null;
    this.destroyed = true;
  }
}

/* ---------------- Receiver ---------------- */

class MeaningReceiver {
  constructor() {
    this.destroyed = false;
    this.onMeaning = null;
  }

  handle(payload) {
    if (this.destroyed || !payload) return;

    const meaning = {
      mimeHint: sanitize(payload.mimeHint),
      category: sanitizeCategory(payload.category),
      sizeRange: sanitize(payload.sizeRange),
    };

    if (this.onMeaning) {
      this.onMeaning(meaning);
    }

    // Immediate destruction — no retention
    this.destroy();
  }

  destroy() {
    this.onMeaning = null;
    this.destroyed = true;
  }
}

export { MeaningSender, MeaningReceiver };
