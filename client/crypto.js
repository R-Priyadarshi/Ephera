/**
 * EPHERA — Application-Layer Crypto (Stage 6, CANONICAL)
 *
 * PURPOSE:
 * - Provide optional app-layer encryption even if signaling is compromised.
 *
 * DESIGN:
 * - Per-transfer AES-256-GCM
 * - Key derived via PBKDF2(passphrase, salt=transferId)
 * - Per-chunk nonce = transferId(8) || chunkIndex(4)  => 12 bytes
 * - Per-chunk AAD binds ciphertext to protocol header fields
 *
 * ZERO-MEMORY:
 * - No persistence, no caching
 * - Derive key once per transfer, encrypt/decrypt chunk-by-chunk
 */

const MSG_CHUNK = 0x02;
const MSG_META = 0x05;

const GCM_TAG_BYTES = 16;
const DEFAULT_PBKDF2_ITERATIONS = 120_000;

const _enc = new TextEncoder();

function _requireWebCrypto() {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('WebCrypto not available');
  }
}

function sanitizePassphrase(value) {
  if (typeof value !== 'string') return null;
  const p = value.trim();
  if (!p) return null;
  // Prevent pathological inputs. This is not security-critical, just sanity.
  if (p.length > 256) return p.slice(0, 256);
  return p;
}

function makeNonce(transferId, chunkIndex) {
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
    throw new Error('Invalid transferId');
  }
  const n = new Uint8Array(12);
  n.set(transferId, 0);
  n[8] = (chunkIndex >>> 24) & 0xff;
  n[9] = (chunkIndex >>> 16) & 0xff;
  n[10] = (chunkIndex >>> 8) & 0xff;
  n[11] = chunkIndex & 0xff;
  return n;
}

function makeChunkAad(transferId, chunkIndex) {
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
    throw new Error('Invalid transferId');
  }
  const aad = new Uint8Array(13);
  aad[0] = MSG_CHUNK;
  aad.set(transferId, 1);
  aad[9] = (chunkIndex >>> 24) & 0xff;
  aad[10] = (chunkIndex >>> 16) & 0xff;
  aad[11] = (chunkIndex >>> 8) & 0xff;
  aad[12] = chunkIndex & 0xff;
  return aad;
}

function makeMetaNonce(transferId) {
  // Reserve chunkIndex = 0xFFFFFFFF for metadata domain.
  return makeNonce(transferId, 0xffffffff);
}

function makeMetaAad(transferId, flags = 0) {
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
    throw new Error('Invalid transferId');
  }
  const f = flags & 0xff;
  const aad = new Uint8Array(10);
  aad[0] = MSG_META;
  aad.set(transferId, 1);
  aad[9] = f;
  return aad;
}

async function deriveAesGcmKey(passphrase, transferId, { iterations = DEFAULT_PBKDF2_ITERATIONS } = {}) {
  _requireWebCrypto();

  const p = sanitizePassphrase(passphrase);
  if (!p) throw new Error('Passphrase required');
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) {
    throw new Error('Invalid transferId');
  }

  const it = Number.isFinite(iterations) ? Math.max(10_000, Math.floor(iterations)) : DEFAULT_PBKDF2_ITERATIONS;

  const material = await crypto.subtle.importKey(
    'raw',
    _enc.encode(p),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: transferId,
      iterations: it,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptChunk(key, transferId, chunkIndex, plaintextU8) {
  _requireWebCrypto();

  const pt = plaintextU8 instanceof Uint8Array ? plaintextU8 : new Uint8Array(plaintextU8);
  const nonce = makeNonce(transferId, chunkIndex);
  const aad = makeChunkAad(transferId, chunkIndex);

  const buf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    pt
  );

  return new Uint8Array(buf);
}

async function decryptChunk(key, transferId, chunkIndex, ciphertextU8) {
  _requireWebCrypto();

  const ct = ciphertextU8 instanceof Uint8Array ? ciphertextU8 : new Uint8Array(ciphertextU8);
  const nonce = makeNonce(transferId, chunkIndex);
  const aad = makeChunkAad(transferId, chunkIndex);

  const buf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    ct
  );

  return new Uint8Array(buf);
}

async function encryptMeta(key, transferId, flags, plaintextU8) {
  _requireWebCrypto();

  const pt = plaintextU8 instanceof Uint8Array ? plaintextU8 : new Uint8Array(plaintextU8);
  const nonce = makeMetaNonce(transferId);
  const aad = makeMetaAad(transferId, flags);

  const buf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    pt
  );

  return new Uint8Array(buf);
}

async function decryptMeta(key, transferId, flags, ciphertextU8) {
  _requireWebCrypto();

  const ct = ciphertextU8 instanceof Uint8Array ? ciphertextU8 : new Uint8Array(ciphertextU8);
  const nonce = makeMetaNonce(transferId);
  const aad = makeMetaAad(transferId, flags);

  const buf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    ct
  );

  return new Uint8Array(buf);
}

export {
  GCM_TAG_BYTES,
  DEFAULT_PBKDF2_ITERATIONS,
  sanitizePassphrase,
  deriveAesGcmKey,
  encryptChunk,
  decryptChunk,
  encryptMeta,
  decryptMeta,
};
