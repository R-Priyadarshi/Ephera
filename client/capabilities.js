/**
 * Capability negotiation utilities.
 *
 * This is a control-plane contract only. No payload data is persisted.
 */

export const CAPABILITIES_SCHEMA_VERSION = 1;
export const DEFAULT_PROTOCOL_VERSION = 1;
export const DEFAULT_MIN_SUPPORTED_VERSION = 1;

const MAX_VERSION = 65535;
const MAX_FEATURES = 32;
const MAX_REQUIRED_FEATURES = 16;
const FEATURE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export const DEFAULT_FEATURES = Object.freeze([
  'capabilities-v1',
  'ready-v1',
  'meaning-v1',
  'receipt-v1',
  'secure-passphrase-v1',
]);

export const DEFAULT_REQUIRED_FEATURES = Object.freeze([
  'capabilities-v1',
]);

function toVersion(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VERSION) return null;
  return n;
}

function sanitizeFeatureName(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  if (!FEATURE_RE.test(s)) return null;
  return s;
}

export function sanitizeFeatureList(value, { limit = MAX_FEATURES } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const f = sanitizeFeatureName(value[i]);
    if (!f || seen.has(f)) continue;
    out.push(f);
    seen.add(f);
    if (out.length >= limit) break;
  }
  return out;
}

export function sanitizeCapabilities(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const v = toVersion(payload.v);
  if (v !== CAPABILITIES_SCHEMA_VERSION) return null;

  const protocolVersion = toVersion(payload.protocolVersion);
  const minSupported = toVersion(payload.minSupported);
  if (!protocolVersion || !minSupported) return null;
  if (minSupported > protocolVersion) return null;

  const features = sanitizeFeatureList(payload.features, { limit: MAX_FEATURES });
  const requiredFeatures = sanitizeFeatureList(payload.requiredFeatures, { limit: MAX_REQUIRED_FEATURES });

  return {
    v: CAPABILITIES_SCHEMA_VERSION,
    protocolVersion,
    minSupported,
    features,
    requiredFeatures,
  };
}

export function buildLocalCapabilities(overrides = {}) {
  const rawVersion = Object.prototype.hasOwnProperty.call(overrides, 'protocolVersion')
    ? overrides.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
  const rawMin = Object.prototype.hasOwnProperty.call(overrides, 'minSupported')
    ? overrides.minSupported
    : DEFAULT_MIN_SUPPORTED_VERSION;

  const protocolVersion = toVersion(rawVersion) || DEFAULT_PROTOCOL_VERSION;
  const minSupportedRaw = toVersion(rawMin) || DEFAULT_MIN_SUPPORTED_VERSION;
  const minSupported = Math.min(minSupportedRaw, protocolVersion);

  const rawFeatures = Array.isArray(overrides.features)
    ? overrides.features
    : Array.from(DEFAULT_FEATURES);
  const rawRequired = Array.isArray(overrides.requiredFeatures)
    ? overrides.requiredFeatures
    : Array.from(DEFAULT_REQUIRED_FEATURES);

  const features = sanitizeFeatureList(rawFeatures, { limit: MAX_FEATURES });
  const requiredFeatures = sanitizeFeatureList(rawRequired, { limit: MAX_REQUIRED_FEATURES });

  // Local requirements should always be advertised as supported.
  const seen = new Set(features);
  for (let i = 0; i < requiredFeatures.length; i++) {
    const f = requiredFeatures[i];
    if (seen.has(f)) continue;
    if (features.length >= MAX_FEATURES) break;
    features.push(f);
    seen.add(f);
  }

  if (!seen.has('capabilities-v1')) {
    if (features.length < MAX_FEATURES) {
      features.push('capabilities-v1');
      seen.add('capabilities-v1');
    }
  }

  const requiredSeen = new Set(requiredFeatures);
  if (!requiredSeen.has('capabilities-v1')) {
    if (requiredFeatures.length < MAX_REQUIRED_FEATURES) {
      requiredFeatures.push('capabilities-v1');
    }
  }

  return {
    v: CAPABILITIES_SCHEMA_VERSION,
    protocolVersion,
    minSupported,
    features,
    requiredFeatures,
  };
}

function formatRange(caps) {
  return `${caps.minSupported}-${caps.protocolVersion}`;
}

export function evaluateCapabilityCompatibility(localCaps, peerCaps) {
  const local = sanitizeCapabilities(localCaps);
  const peer = sanitizeCapabilities(peerCaps);

  if (!local || !peer) {
    return {
      ok: false,
      negotiatedVersion: null,
      reason: 'Protocol negotiation pending',
      code: 'pending',
    };
  }

  const overlapMin = Math.max(local.minSupported, peer.minSupported);
  const overlapMax = Math.min(local.protocolVersion, peer.protocolVersion);
  if (overlapMin > overlapMax) {
    return {
      ok: false,
      negotiatedVersion: null,
      reason: `Protocol version mismatch (local ${formatRange(local)} / peer ${formatRange(peer)})`,
      code: 'version_mismatch',
    };
  }

  const peerFeatures = new Set(peer.features);
  const localFeatures = new Set(local.features);

  const missingPeer = [];
  for (let i = 0; i < local.requiredFeatures.length; i++) {
    const f = local.requiredFeatures[i];
    if (!peerFeatures.has(f)) missingPeer.push(f);
  }
  if (missingPeer.length > 0) {
    return {
      ok: false,
      negotiatedVersion: null,
      reason: `Peer missing required feature(s): ${missingPeer.join(', ')}`,
      code: 'peer_missing_required',
    };
  }

  const missingLocal = [];
  for (let i = 0; i < peer.requiredFeatures.length; i++) {
    const f = peer.requiredFeatures[i];
    if (!localFeatures.has(f)) missingLocal.push(f);
  }
  if (missingLocal.length > 0) {
    return {
      ok: false,
      negotiatedVersion: null,
      reason: `Local missing required feature(s): ${missingLocal.join(', ')}`,
      code: 'local_missing_required',
    };
  }

  return {
    ok: true,
    negotiatedVersion: overlapMax,
    reason: `Protocol compatible (v${overlapMax})`,
    code: 'ok',
  };
}

