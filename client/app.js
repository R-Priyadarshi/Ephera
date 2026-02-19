/**
 * EPHERA — Minimal UI Wiring (Corrected)
 *
 * ZERO-MEMORY GUARANTEES:
 * - No persistence
 * - No accumulation
 * - Deterministic teardown
 */

import { EpheraTransport } from './transport.js';
import { EpheraSender } from './sender.js';
import { EpheraReceiver, MSG_ABORT, MSG_META } from './receiver.js';
import { SessionManager } from './session/SessionManager.js';
import { MeaningSender, MeaningReceiver } from './meaning.js';
import { sanitizePassphrase, deriveAesGcmKey, decryptChunk, decryptMeta, encryptMeta } from './crypto.js';

const _dec = new TextDecoder();
const _enc = new TextEncoder();

const PARAMS = new URLSearchParams(location.search);
const IS_E2E = PARAMS.get('e2e') === '1' || PARAMS.has('e2e');
const E2E_ROLE = PARAMS.get('role'); // 'create' | 'join'
const E2E_AUTO_READY = PARAMS.get('autoReady') === '1' || PARAMS.has('autoReady');
const E2E_RECV_DELAY_MS = (() => {
  if (!IS_E2E) return 0;
  const raw = Number(PARAMS.get('recvDelayMs') || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1000, Math.max(0, Math.floor(raw)));
})();

const E2E_STATE = IS_E2E ? (window.__epheraE2E = {
  role: E2E_ROLE || null,
  signalingConnected: false,
  signalingReconnects: 0,
  transportOpen: false,
  peerReady: false,
  passphraseVerified: false,
  iceConnectionState: null,
  sentBytes: 0,
  sentTotalBytes: 0,
  sentDone: false,
  sentDoneCount: 0,
  sentAbortCount: 0,
  deliveredCount: 0,
  deliveredSavedCount: 0,
  deliveredDiscardCount: 0,
  recvBytes: 0,
  recvTotalBytes: 0,
  recvDone: false,
  recvDoneCount: 0,
  recvAbortCount: 0,
  recvTitle: null,
  recvTitles: [],
  sessionWeakRefs: [],
  restartCount: 0,
  restartInFlight: false,
  error: null,
}) : null;

const SIGNALING_URL = (() => {
  const explicit = PARAMS.get('signalUrl');
  if (explicit) return explicit;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  // Default: same-origin signaling (recommended for deployment).
  // Override:
  // - ?signalUrl=ws(s)://host:port
  // - ?signalPort=8080 (or ?signal=8080)
  const rawPort = PARAMS.get('signalPort') || PARAMS.get('signal');
  if (rawPort) {
    const signalPort = Number(rawPort) || 8080;
    const host = location.hostname || 'localhost';
    return `${proto}://${host}:${signalPort}`;
  }

  const host = location.host || `${location.hostname || 'localhost'}:8080`;
  return `${proto}://${host}`;
})();

function stripPassphraseFromUrl() {
  // If a share link contained a passphrase, remove it from the address bar and
  // from PARAMS to avoid accidental persistence (history, server access logs).
  try {
    if (!PARAMS.has('passphrase')) return;
    const url = new URL(location.href);
    url.searchParams.delete('passphrase');
    PARAMS.delete('passphrase');
    history.replaceState(null, '', url.toString());
  } catch {}
}

function stripIceFromUrl() {
  // If a share link contained ICE/TURN config, remove it from the address bar and
  // from PARAMS to avoid accidental persistence (history, server access logs).
  try {
    const keys = [
      'iceServers',
      'icePolicy',
      'stun',
      'turn',
      'turnUser',
      'turnUsername',
      'turnPass',
      'turnCredential',
    ];

    let had = false;
    for (const k of keys) {
      if (PARAMS.has(k)) {
        had = true;
        break;
      }
    }
    if (!had) return;

    const url = new URL(location.href);
    for (const k of keys) {
      try { url.searchParams.delete(k); } catch {}
      try { PARAMS.delete(k); } catch {}
    }
    history.replaceState(null, '', url.toString());
  } catch {}
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    let urls = item.urls;
    if (typeof urls === 'string') {
      urls = urls.trim();
      if (!urls) continue;
    } else if (Array.isArray(urls)) {
      const list = [];
      for (const u of urls) {
        if (typeof u === 'string' && u.trim()) list.push(u.trim());
        if (list.length >= 8) break;
      }
      if (list.length === 0) continue;
      urls = list.length === 1 ? list[0] : list;
    } else {
      continue;
    }

    const server = { urls };
    if (typeof item.username === 'string' && item.username) server.username = item.username;
    if (typeof item.credential === 'string' && item.credential) server.credential = item.credential;
    if (typeof item.credentialType === 'string' && item.credentialType) server.credentialType = item.credentialType;

    out.push(server);
    if (out.length >= 8) break;
  }
  return out.length ? out : null;
}

function parseIceServersFromParams(params) {
  const raw = params.get('iceServers');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const sanitized = sanitizeIceServers(parsed);
      if (sanitized) return sanitized;
    } catch {}
  }

  const servers = [];
  for (const stun of params.getAll('stun')) {
    if (typeof stun === 'string' && stun.trim()) servers.push({ urls: stun.trim() });
    if (servers.length >= 8) break;
  }

  const turns = params.getAll('turn').filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim());
  if (turns.length > 0) {
    const username = params.get('turnUser') || params.get('turnUsername') || '';
    const credential = params.get('turnPass') || params.get('turnCredential') || '';
    const turn = { urls: turns.length === 1 ? turns[0] : turns };
    if (username) turn.username = username;
    if (credential) turn.credential = credential;
    servers.push(turn);
  }

  return servers.length ? servers : null;
}

function hasIceServersInParams(params) {
  if (!params) return false;
  return (
    params.has('iceServers') ||
    params.getAll('stun').length > 0 ||
    params.getAll('turn').length > 0 ||
    params.has('turnUser') ||
    params.has('turnUsername') ||
    params.has('turnPass') ||
    params.has('turnCredential')
  );
}

const ICE_SERVERS = parseIceServersFromParams(PARAMS);
const ICE_POLICY = (() => {
  const raw = PARAMS.get('icePolicy');
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'relay') return 'relay';
  return null;
})();

/* ---------- DOM ---------- */

const roomIdInput = document.getElementById('room-id');
const generateRoomIdBtn = document.getElementById('generate-room-id');
const createRoomBtn = document.getElementById('create-room');
const joinRoomBtn = document.getElementById('join-room');
const disconnectBtn = document.getElementById('disconnect');
const joinLinkInput = document.getElementById('join-link');
const copyJoinLinkBtn = document.getElementById('copy-join-link');
const shareJoinLinkBtn = document.getElementById('share-join-link');

const transferSection = document.getElementById('transfer-controls');
const pickReceiveFolderBtn = document.getElementById('pick-receive-folder');
const readyDiscardBtn = document.getElementById('ready-discard');
const receiveFolderLabel = document.getElementById('receive-folder-label');
const peerStateEl = document.getElementById('peer-state');
const fileInput = document.getElementById('file-input');
const sendFileBtn = document.getElementById('send-file');
const sendWeightInput = document.getElementById('send-weight');
const sendWeightValue = document.getElementById('send-weight-value');
const transfersEl = document.getElementById('transfers');
const passphraseInput = document.getElementById('passphrase');
const generatePassphraseBtn = document.getElementById('generate-passphrase');
const copyPassphraseBtn = document.getElementById('copy-passphrase');
const sharePassphraseBtn = document.getElementById('share-passphrase');
const clearPassphraseBtn = document.getElementById('clear-passphrase');
const includePassphraseLinkInput = document.getElementById('include-passphrase-link');
const includeIceLinkInput = document.getElementById('include-ice-link');
const cryptoStateEl = document.getElementById('crypto-state');
const statusEl = document.getElementById('status');
const iceServersJsonInput = document.getElementById('ice-servers-json');
const iceRelayOnlyInput = document.getElementById('ice-relay-only');
const iceStateEl = document.getElementById('ice-state');
const enableDiagnosticsInput = document.getElementById('enable-diagnostics');
const copyDiagnosticsBtn = document.getElementById('copy-diagnostics');
const diagnosticsEl = document.getElementById('diagnostics');

/* ---------- State ---------- */

let ws = null;
let transport = null;
let receiver = null;
let sessionManager = null;
let transportOpen = false;
let peerReady = false;
let peerCryptoMode = 'none'; // 'none' | 'passphrase'
let peerMeaning = null;
let localReady = false;
let isInitiator = false;
let restartInFlight = false;
let restartTimer = null;
let receiveDirHandle = null; // FileSystemDirectoryHandle (optional)
let pendingIce = [];

let iceServersOverride = null;
let runtimeIceServers = null;
let iceRelayOnly = false;

let passphraseVerified = false;
let handshakeLastSentAt = 0;
let handshakeSending = false;

let diagnosticsEnabled = false;
let diagnosticsTimer = null;
let lastDiagnosticsText = '';

let activeRoomId = null;
let signalingReconnectTimer = null;
let signalingReconnectAttempts = 0;
let signalingReconnectInFlight = false;

// Allow multiple concurrent outbound transfers (Stage 3/4 engine supports this).
const activeSenders = new Set();

// Track outbound transfers by transferId so we can:
// - abort sending if the receiver requests it (peer ABORT)
// - mark "delivered" when the receiver sends a receipt META
const outboundTransfers = new Map(); // Map<string(hexId), { row, sender, receiptTimer, delivered }>

/* ---------- Runtime Config ---------- */

async function loadRuntimeConfig() {
  if (typeof fetch !== 'function') return;

  let res = null;
  try {
    res = await fetch('/runtime-config', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    return;
  }

  if (!res || !res.ok) return;

  let cfg = null;
  try {
    cfg = await res.json();
  } catch {
    return;
  }
  if (!cfg || typeof cfg !== 'object') return;

  const hasIcePolicyParam = PARAMS.has('icePolicy');
  const hasIceServersParam = hasIceServersInParams(PARAMS);
  let loaded = false;

  if (!hasIceServersParam) {
    const sanitized = sanitizeIceServers(cfg.iceServers);
    if (sanitized) {
      runtimeIceServers = sanitized;
      loaded = true;
      if (iceServersJsonInput && !iceServersJsonInput.value.trim()) {
        try { iceServersJsonInput.value = JSON.stringify(sanitized, null, 2); } catch {}
      }
      setIceState(`ICE servers: ${sanitized.length} (server default)`);
    }
  }

  if (!hasIcePolicyParam && typeof cfg.icePolicy === 'string' && cfg.icePolicy.trim().toLowerCase() === 'relay') {
    iceRelayOnly = true;
    if (iceRelayOnlyInput) iceRelayOnlyInput.checked = true;
    loaded = true;
    if (!runtimeIceServers) setIceState('ICE policy: relay (server default)');
  }

  if (loaded) updateJoinLink();
}

const RUNTIME_CONFIG_READY = loadRuntimeConfig().catch(() => {});

/* ---------- UI helpers ---------- */

const CAN_SHARE = !!(navigator.share && typeof navigator.share === 'function');
if (shareJoinLinkBtn) shareJoinLinkBtn.hidden = !CAN_SHARE;
if (sharePassphraseBtn) sharePassphraseBtn.hidden = !CAN_SHARE;
if (sharePassphraseBtn) sharePassphraseBtn.disabled = true;

function setStatus(text) {
  statusEl.textContent = text;
}

function setIceState(text) {
  if (!iceStateEl) return;
  iceStateEl.textContent = text || '';
}

function generateRoomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.match(/.{1,4}/g).join('-');
}

function getIceServers() {
  return iceServersOverride || ICE_SERVERS || runtimeIceServers || null;
}

function getRtcConfig() {
  return iceRelayOnly ? { iceTransportPolicy: 'relay' } : null;
}

function buildJoinLink({ includePassphrase = false, includeIce = false } = {}) {
  const roomId = roomIdInput.value.trim();
  if (!roomId) return '';

  const url = new URL(location.origin + location.pathname);

  // Carry connection config forward if it was explicitly set.
  const passthrough = [
    'signalUrl',
    'signalPort',
    'signal',
  ];

  for (const k of passthrough) {
    const v = PARAMS.get(k);
    if (v) url.searchParams.set(k, v);
  }

  if (includeIce) {
    if (iceServersOverride) {
      try {
        url.searchParams.set('iceServers', JSON.stringify(iceServersOverride));
      } catch {}
    } else {
      const iceKeys = [
        'iceServers',
        'turnUser',
        'turnUsername',
        'turnPass',
        'turnCredential',
      ];
      for (const k of iceKeys) {
        const v = PARAMS.get(k);
        if (v) url.searchParams.set(k, v);
      }

      for (const stun of PARAMS.getAll('stun')) url.searchParams.append('stun', stun);
      for (const turn of PARAMS.getAll('turn')) url.searchParams.append('turn', turn);
    }

    if (iceRelayOnly) {
      url.searchParams.set('icePolicy', 'relay');
    }
  }

  url.searchParams.set('roomId', roomId);
  // UX: opening a join link should immediately join the room (no extra clicks).
  url.searchParams.set('autojoin', '1');

  if (includePassphrase) {
    const p = getLocalPassphrase();
    if (p) url.searchParams.set('passphrase', p);
  }

  return url.toString();
}

function updateJoinLink() {
  if (!joinLinkInput) return;

  const includePassphrase = !!getLocalPassphrase() && !!(includePassphraseLinkInput && includePassphraseLinkInput.checked);
  const includeIce = !!(includeIceLinkInput && includeIceLinkInput.checked);
  const link = buildJoinLink({ includePassphrase, includeIce });
  joinLinkInput.value = link;
  if (copyJoinLinkBtn) copyJoinLinkBtn.disabled = !link;
  if (shareJoinLinkBtn) shareJoinLinkBtn.disabled = !link;
}

async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}

  try { ta.remove(); } catch {}
  return ok;
}

/* ---------- Diagnostics (Local Only) ---------- */

let diagnosticsInFlight = false;

function setDiagnosticsText(text) {
  if (diagnosticsEl) diagnosticsEl.textContent = text || '';
  lastDiagnosticsText = text || '';
  if (copyDiagnosticsBtn) copyDiagnosticsBtn.disabled = !lastDiagnosticsText;
}

function sanitizeCandidateStats(c) {
  // MUST NOT expose IP addresses / ports / ICE server URLs.
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (typeof c.candidateType === 'string') out.candidateType = c.candidateType;
  if (typeof c.protocol === 'string') out.protocol = c.protocol;
  if (typeof c.networkType === 'string') out.networkType = c.networkType;
  if (typeof c.relayProtocol === 'string') out.relayProtocol = c.relayProtocol;
  return Object.keys(out).length ? out : null;
}

async function collectDiagnosticsSnapshot(forTransport) {
  const t = forTransport || null;
  const pc = t && t.pc ? t.pc : null;
  const ch = t && t.channel ? t.channel : null;

  const snap = {
    v: 1,
    ts: new Date().toISOString(),
    app: {
      transportOpen: !!transportOpen,
      peerReady: !!peerReady,
      isSecureContext: !!window.isSecureContext,
      hasDirectoryPicker: typeof window.showDirectoryPicker === 'function',
      localCryptoMode: getLocalCryptoMode(),
      peerCryptoMode,
      iceRelayOnly: !!iceRelayOnly,
      iceServersCount: Array.isArray(getIceServers()) ? getIceServers().length : 0,
    },
  };

  if (!pc) {
    snap.note = 'no RTCPeerConnection';
    if (ch) {
      snap.channel = {
        readyState: ch.readyState,
        bufferedAmount: typeof ch.bufferedAmount === 'number' ? Math.max(0, Math.floor(ch.bufferedAmount)) : 0,
      };
    }
    return snap;
  }

  snap.pc = {
    iceConnectionState: pc.iceConnectionState || null,
    iceGatheringState: pc.iceGatheringState || null,
    signalingState: pc.signalingState || null,
    connectionState: pc.connectionState || null,
  };

  if (ch) {
    snap.channel = {
      readyState: ch.readyState,
      bufferedAmount: typeof ch.bufferedAmount === 'number' ? Math.max(0, Math.floor(ch.bufferedAmount)) : 0,
    };
  }

  let report = null;
  try {
    report = await pc.getStats();
  } catch {
    snap.note = 'getStats failed';
    return snap;
  }

  const byId = new Map();
  try {
    report.forEach((v) => {
      if (v && typeof v.id === 'string') byId.set(v.id, v);
    });
  } catch {}

  let selectedPair = null;
  try {
    for (const v of byId.values()) {
      if (v && v.type === 'transport' && v.selectedCandidatePairId) {
        const pair = byId.get(v.selectedCandidatePairId);
        if (pair && pair.type === 'candidate-pair') {
          selectedPair = pair;
          break;
        }
      }
    }

    if (!selectedPair) {
      for (const v of byId.values()) {
        if (v && v.type === 'candidate-pair' && v.selected === true) {
          selectedPair = v;
          break;
        }
      }
    }

    if (!selectedPair) {
      for (const v of byId.values()) {
        if (v && v.type === 'candidate-pair' && v.nominated === true && v.state === 'succeeded') {
          selectedPair = v;
          break;
        }
      }
    }
  } catch {}

  if (selectedPair) {
    const rtt = typeof selectedPair.currentRoundTripTime === 'number' ? selectedPair.currentRoundTripTime : null;

    const selected = {
      state: selectedPair.state || null,
      nominated: selectedPair.nominated === true,
      rttMs: rtt != null ? Math.round(rtt * 1000) : null,
      availableOutgoingBitrate: typeof selectedPair.availableOutgoingBitrate === 'number'
        ? Math.floor(selectedPair.availableOutgoingBitrate)
        : null,
      bytesSent: typeof selectedPair.bytesSent === 'number' ? Math.floor(selectedPair.bytesSent) : null,
      bytesReceived: typeof selectedPair.bytesReceived === 'number' ? Math.floor(selectedPair.bytesReceived) : null,
      localCandidate: null,
      remoteCandidate: null,
    };

    const local = selectedPair.localCandidateId ? byId.get(selectedPair.localCandidateId) : null;
    const remote = selectedPair.remoteCandidateId ? byId.get(selectedPair.remoteCandidateId) : null;
    selected.localCandidate = sanitizeCandidateStats(local);
    selected.remoteCandidate = sanitizeCandidateStats(remote);

    snap.selectedCandidatePair = selected;
  }

  // If present, include a minimal data-channel stat block.
  try {
    for (const v of byId.values()) {
      if (!v || v.type !== 'data-channel') continue;
      if (v.label && v.label !== 'ephera') continue;
      snap.dataChannel = {
        state: v.state || null,
        messagesSent: typeof v.messagesSent === 'number' ? Math.floor(v.messagesSent) : null,
        messagesReceived: typeof v.messagesReceived === 'number' ? Math.floor(v.messagesReceived) : null,
        bytesSent: typeof v.bytesSent === 'number' ? Math.floor(v.bytesSent) : null,
        bytesReceived: typeof v.bytesReceived === 'number' ? Math.floor(v.bytesReceived) : null,
      };
      break;
    }
  } catch {}

  return snap;
}

async function updateDiagnosticsNow() {
  if (!diagnosticsEnabled) return;
  if (diagnosticsInFlight) return;
  diagnosticsInFlight = true;

  const t = transport;
  try {
    const snap = await collectDiagnosticsSnapshot(t);
    // Avoid rendering stats from a stale transport after reconnect.
    if (t !== transport) return;
    const text = JSON.stringify(snap, null, 2);
    setDiagnosticsText(text);
  } catch {
    // Silent: diagnostics must never affect app behaviour.
  } finally {
    diagnosticsInFlight = false;
  }
}

function startDiagnostics() {
  diagnosticsEnabled = true;
  if (diagnosticsTimer) return;
  setDiagnosticsText('');
  updateDiagnosticsNow().catch(() => {});
  diagnosticsTimer = setInterval(() => {
    updateDiagnosticsNow().catch(() => {});
  }, 1000);
}

function stopDiagnostics() {
  diagnosticsEnabled = false;
  if (diagnosticsTimer) {
    clearInterval(diagnosticsTimer);
    diagnosticsTimer = null;
  }
  diagnosticsInFlight = false;
  setDiagnosticsText('');
}

function getLocalPassphrase() {
  if (!passphraseInput) return null;
  return sanitizePassphrase(passphraseInput.value);
}

function getLocalCryptoMode() {
  return getLocalPassphrase() ? 'passphrase' : 'none';
}

function updateSendButton() {
  const localMode = getLocalCryptoMode();
  const modeOk = peerCryptoMode === localMode;
  const passOk = localMode !== 'passphrase' || passphraseVerified;
  sendFileBtn.disabled = !(
    transportOpen &&
    peerReady &&
    modeOk &&
    passOk &&
    fileInput.files.length >= 1
  );
}

function setPeerState(text) {
  peerStateEl.textContent = text || '';
}

function setCryptoState(text) {
  if (!cryptoStateEl) return;
  cryptoStateEl.textContent = text || '';
}

function renderPeerState() {
  const parts = [];
  parts.push(peerReady ? 'Peer ready' : 'Peer not ready');
  parts.push(`crypto=${peerCryptoMode}`);
  if (peerMeaning) parts.push(`intent: ${peerMeaning}`);
  setPeerState(parts.join(' | '));

  const localMode = getLocalCryptoMode();
  const match = localMode === peerCryptoMode ? 'match' : 'mismatch';
  let extra = '';
  if (match === 'mismatch') {
    if (localMode === 'passphrase' && peerCryptoMode === 'none') extra = ' (peer must set passphrase)';
    if (localMode === 'none' && peerCryptoMode === 'passphrase') extra = ' (set passphrase to match peer)';
  } else if (localMode === 'none') {
    extra = ' (plain mode)';
  } else if (localMode === 'passphrase') {
    extra = passphraseVerified ? ' (encrypted, verified)' : ' (encrypted, verifying...)';
  }
  setCryptoState(`Crypto: local=${localMode} / peer=${peerCryptoMode} (${match})${extra}`);
}

function setReceiveFolderLabel(text) {
  receiveFolderLabel.textContent = text || '';
}

function addTransferRow({ direction, title }) {
  const row = document.createElement('div');
  row.className = `transfer transfer-${direction}`;

  const head = document.createElement('div');
  head.className = 'transfer-head';

  const dir = document.createElement('span');
  dir.className = `transfer-dir transfer-dir-${direction}`;
  dir.textContent = direction === 'out' ? 'OUT' : 'IN';

  const name = document.createElement('span');
  name.className = 'transfer-title';
  name.textContent = title;

  let onCancel = null;
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'transfer-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = true;
  cancelBtn.disabled = true;
  cancelBtn.onclick = () => {
    if (onCancel) onCancel();
  };

  head.appendChild(dir);
  head.appendChild(name);
  head.appendChild(cancelBtn);

  const meta = document.createElement('div');
  meta.className = 'transfer-meta';

  const status = document.createElement('span');
  status.className = 'transfer-status';
  status.textContent = 'pending';

  const bytes = document.createElement('span');
  bytes.className = 'transfer-bytes';
  bytes.textContent = '0 B';

  const speed = document.createElement('span');
  speed.className = 'transfer-speed';
  speed.textContent = '';

  meta.appendChild(status);
  meta.appendChild(bytes);
  meta.appendChild(speed);

  row.appendChild(head);
  row.appendChild(meta);

  const progress = document.createElement('div');
  progress.className = 'transfer-progress';
  progress.hidden = true;

  const progressFill = document.createElement('div');
  progressFill.className = 'transfer-progress-fill';
  progress.appendChild(progressFill);

  row.appendChild(progress);

  transfersEl.appendChild(row);

  return {
    setTitle: (t) => { name.textContent = t; },
    setStatus: (t) => { status.textContent = t; },
    setBytes: (n) => { bytes.textContent = formatBytes(n); },
    setSpeed: (bps) => { speed.textContent = bps ? String(bps) : ''; },
    setProgress: (pct) => {
      const p = Number(pct);
      if (!Number.isFinite(p) || p < 0) {
        progress.hidden = true;
        progressFill.style.width = '0%';
        return;
      }
      const v = Math.max(0, Math.min(100, Math.floor(p)));
      progress.hidden = false;
      progressFill.style.width = `${v}%`;
    },
    setCancel: (fn, { label = 'Cancel' } = {}) => {
      onCancel = typeof fn === 'function' ? fn : null;
      cancelBtn.textContent = label;
      cancelBtn.hidden = !onCancel;
      cancelBtn.disabled = !onCancel;
    },
    destroy: () => { try { row.remove(); } catch {} },
  };
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.floor(x)) : x.toFixed(1);
  return `${s} ${units[i]}`;
}

function sanitizeFileName(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;

  // Remove any path semantics. DirectoryHandle APIs should reject these,
  // but sanitize anyway to keep behavior deterministic.
  s = s.replace(/[\\/]/g, '_');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '_');
  s = s.replace(/[. ]+$/g, '');

  if (!s || s === '.' || s === '..') return null;

  const MAX = 120;
  if (s.length > MAX) {
    const dot = s.lastIndexOf('.');
    if (dot > 0 && dot < s.length - 1 && s.length - dot <= 16) {
      const ext = s.slice(dot);
      s = s.slice(0, Math.max(1, MAX - ext.length)) + ext;
    } else {
      s = s.slice(0, MAX);
    }
  }

  return s;
}

function hexId(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    s += u8[i].toString(16).padStart(2, '0');
  }
  return s;
}

const META_FLAG_ENCRYPTED = 0x01;
const MAX_RECEIPT_PLAINTEXT_BYTES = 1024;
const RECEIPT_TIMEOUT_MS = 120 * 1000;

// Control-only META frames (not associated with a TransferSession) MUST use
// a transferId from a disjoint domain so they can never be routed as session META.
// Reserved domain: transferId[0] high bit set.
const HANDSHAKE_DOMAIN_BIT = 0x80;
const MAX_HANDSHAKE_PLAINTEXT_BYTES = 256;
const HANDSHAKE_DEBOUNCE_MS = 1500;

function encodeAbortFrame(transferId) {
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) return null;
  const msg = new Uint8Array(9);
  msg[0] = MSG_ABORT;
  msg.set(transferId, 1);
  return msg;
}

function encodeMetaFrame(transferId, flags, metaPayload) {
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) return null;
  const payload = metaPayload instanceof Uint8Array ? metaPayload : new Uint8Array(metaPayload);
  const len = payload.byteLength;
  if (len > 0xffff) return null;
  const msg = new Uint8Array(12 + len);
  msg[0] = MSG_META;
  msg.set(transferId, 1);
  msg[9] = flags & 0xff;
  msg[10] = (len >>> 8) & 0xff;
  msg[11] = len & 0xff;
  msg.set(payload, 12);
  return msg;
}

function clearOutboundTransfers() {
  for (const v of outboundTransfers.values()) {
    if (v && v.receiptTimer) {
      try { clearTimeout(v.receiptTimer); } catch {}
      v.receiptTimer = null;
    }
  }
  outboundTransfers.clear();
}

function sendPeerAbort(transferId) {
  if (!transport || !transportOpen) return;
  const frame = encodeAbortFrame(transferId);
  if (!frame) return;
  transport.send(frame).catch(() => {});
}

function resetPassphraseVerification() {
  passphraseVerified = false;
  handshakeLastSentAt = 0;
  handshakeSending = false;
  if (E2E_STATE) E2E_STATE.passphraseVerified = false;
}

function makeHandshakeTransferId() {
  const id = new Uint8Array(8);
  crypto.getRandomValues(id);
  id[0] |= HANDSHAKE_DOMAIN_BIT;
  return id;
}

function isHandshakeTransferId(transferId) {
  return (
    (transferId instanceof Uint8Array) &&
    transferId.length === 8 &&
    (transferId[0] & HANDSHAKE_DOMAIN_BIT) === HANDSHAKE_DOMAIN_BIT
  );
}

async function maybeSendPassphraseHandshake(reason) {
  // Best-effort: confirms both peers share the same passphrase so we don't
  // waste time/bandwidth sending a large encrypted transfer that will fail.
  if (!transport || !transportOpen) return;
  if (getLocalCryptoMode() !== 'passphrase') return;

  const now = Date.now();
  if (handshakeSending) return;
  if (handshakeLastSentAt && (now - handshakeLastSentAt) < HANDSHAKE_DEBOUNCE_MS) return;

  const passphrase = getLocalPassphrase();
  if (!passphrase) return;

  handshakeSending = true;
  handshakeLastSentAt = now;

  const transferId = makeHandshakeTransferId();

  try {
    const aesKey = await deriveAesGcmKey(passphrase, transferId);
    const obj = { v: 1, kind: 'handshake', ts: now, reason: String(reason || '') };
    const plain = _enc.encode(JSON.stringify(obj));
    if (plain.byteLength === 0 || plain.byteLength > MAX_HANDSHAKE_PLAINTEXT_BYTES) return;

    const flags = META_FLAG_ENCRYPTED;
    const encrypted = await encryptMeta(aesKey, transferId, flags, plain);
    const frame = encodeMetaFrame(transferId, flags, encrypted);
    if (!frame) return;

    await transport.send(frame);
  } catch {
    // Ignore: handshake is UX-only and must never disrupt the app.
  } finally {
    handshakeSending = false;
  }
}

async function handleInboundHandshakeMetaFrame(frame, transferId) {
  if (getLocalCryptoMode() !== 'passphrase') return;

  if (!(frame instanceof Uint8Array) || frame.byteLength < 12) return;

  const flags = frame[9] & 0xff;
  const metaLen = ((frame[10] << 8) | frame[11]) >>> 0;
  if (metaLen > 4096) return;
  if (12 + metaLen !== frame.byteLength) return;

  const encrypted = (flags & META_FLAG_ENCRYPTED) !== 0;
  if (!encrypted) return;

  const passphrase = getLocalPassphrase();
  if (!passphrase) return;

  let aesKey = null;
  try {
    aesKey = await deriveAesGcmKey(passphrase, transferId);
  } catch {
    return;
  }

  let payload = frame.subarray(12, 12 + metaLen);
  try {
    payload = await decryptMeta(aesKey, transferId, flags, payload);
  } catch {
    if (passphraseVerified) {
      passphraseVerified = false;
      if (E2E_STATE) E2E_STATE.passphraseVerified = false;
      renderPeerState();
      updateSendButton();
    }
    return;
  }

  let obj = null;
  try {
    obj = JSON.parse(_dec.decode(payload));
  } catch {
    return;
  }

  // Any successful decryption of a reserved-domain handshake META proves the passphrase matches.
  // Keep the JSON check for debugging / future-proofing, but don't require it for verification.
  if (!obj || typeof obj !== 'object' || obj.v !== 1 || obj.kind !== 'handshake') {
    // Still accept as verification if decrypt succeeded.
  }

  if (!passphraseVerified) {
    passphraseVerified = true;
    if (E2E_STATE) E2E_STATE.passphraseVerified = true;
    renderPeerState();
    updateSendButton();
  }
}

async function sendReceipt(transferId, { aesKey = null, status = 'ok', sink = 'discarded', bytes = 0 } = {}) {
  if (!transport || !transportOpen) return;
  if (!(transferId instanceof Uint8Array) || transferId.length !== 8) return;

  const b = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  const receipt = {
    v: 1,
    kind: 'receipt',
    status: status === 'ok' ? 'ok' : 'abort',
    sink: sink === 'saved' ? 'saved' : 'discarded',
    bytes: b,
  };

  let plain;
  try {
    plain = _enc.encode(JSON.stringify(receipt));
  } catch {
    return;
  }

  if (plain.byteLength === 0 || plain.byteLength > MAX_RECEIPT_PLAINTEXT_BYTES) return;

  let flags = 0;
  let payload = plain;

  if (aesKey) {
    flags |= META_FLAG_ENCRYPTED;
    try {
      payload = await encryptMeta(aesKey, transferId, flags, plain);
    } catch {
      return;
    }
  }

  const frame = encodeMetaFrame(transferId, flags, payload);
  if (!frame) return;

  // Best-effort; never throw.
  transport.send(frame).catch(() => {});
}

/* ---------- Signaling ---------- */

function clearSignalingReconnect() {
  if (signalingReconnectTimer) {
    clearTimeout(signalingReconnectTimer);
    signalingReconnectTimer = null;
  }
  signalingReconnectAttempts = 0;
  signalingReconnectInFlight = false;
}

function scheduleSignalingReconnect() {
  if (!transportOpen) return;
  if (!activeRoomId) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (signalingReconnectTimer || signalingReconnectInFlight) return;

  const attempt = Math.max(0, Math.floor(signalingReconnectAttempts));
  const base = 250;
  const max = 10_000;
  const delay = Math.min(max, base * (2 ** attempt)) + Math.floor(Math.random() * 200);

  signalingReconnectTimer = setTimeout(() => {
    signalingReconnectTimer = null;
    attemptSignalingReconnect().then((ok) => {
      if (ok) {
        signalingReconnectAttempts = 0;
        return;
      }
      signalingReconnectAttempts = Math.min(30, Math.max(0, Math.floor(signalingReconnectAttempts)) + 1);
      scheduleSignalingReconnect();
    }).catch(() => {
      signalingReconnectAttempts = Math.min(30, Math.max(0, Math.floor(signalingReconnectAttempts)) + 1);
      scheduleSignalingReconnect();
    });
  }, delay);
}

async function attemptSignalingReconnect() {
  if (!transportOpen) return false;
  if (!activeRoomId) return false;
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (signalingReconnectInFlight) return false;

  signalingReconnectInFlight = true;

  try {
    const roomId = activeRoomId;
    const initiator = !!isInitiator;

    const socket = new WebSocket(SIGNALING_URL);
    let settled = false;
    let triedCreate = false;

    const ok = await new Promise((resolve) => {
      socket.onopen = () => {
        if (!transportOpen) {
          try { socket.close(); } catch {}
          resolve(false);
          return;
        }

        try {
          socket.send(JSON.stringify({ type: 'join-room', roomId }));
        } catch {
          try { socket.close(); } catch {}
          resolve(false);
        }
      };

      socket.onmessage = async (e) => {
        if (!transportOpen) return;

        let msg = null;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'room-joined' || msg.type === 'room-created') {
          settled = true;
          ws = socket;
          if (E2E_STATE) {
            E2E_STATE.signalingConnected = true;
            E2E_STATE.signalingReconnects = (E2E_STATE.signalingReconnects || 0) + 1;
          }

          // Re-announce readiness state after reconnect so the peer UI remains correct.
          try {
            sendApp('ready', { value: !!localReady, cryptoMode: getLocalCryptoMode() });
          } catch {}

          // If the transport is unhealthy, try an ICE restart now that signaling is back.
          try {
            if (initiator && transport && transport.pc) {
              const s = transport.pc.iceConnectionState;
              if (s === 'failed' || s === 'disconnected') {
                triggerIceRestart('signaling reconnected').catch(() => {});
              }
            }
          } catch {}

          setStatus('Signaling reconnected');
          resolve(true);
          return;
        }

        if (msg.type === 'peer-joined' && initiator) {
          // Only negotiate a new connection if we don't already have one.
          if (!transport) {
            await startConnection();
          } else {
            setStatus('Peer joined signaling (P2P active)');
          }
          return;
        }

        if (msg.type === 'signal') {
          await handleSignal(msg.payload);
          return;
        }

        if (msg.type === 'peer-left') {
          if (transportOpen) {
            setStatus('Peer left signaling (P2P active)');
            return;
          }
          cleanup();
          return;
        }

        if (msg.type === 'error') {
          const message = typeof msg.message === 'string' ? msg.message : 'Signaling error';

          // During reconnect, "room not found" can happen if the signaling server restarted.
          if (!settled) {
            if (message === 'Room not found') {
              if (initiator && !triedCreate) {
                triedCreate = true;
                try {
                  socket.send(JSON.stringify({ type: 'create-room', roomId }));
                  return;
                } catch {}
              }

              // Joiners never create rooms. Retry later.
              try { socket.close(); } catch {}
              resolve(false);
              return;
            }

            if (initiator && message === 'Room already exists') {
              // Race: if the peer recreated the room, try join.
              try {
                socket.send(JSON.stringify({ type: 'join-room', roomId }));
                return;
              } catch {}
            }

            if (message === 'Room full') {
              try { socket.close(); } catch {}
              resolve(false);
              return;
            }
          }

          setStatus(message);
        }
      };

      socket.onerror = () => {
        // onclose will follow; keep logic deterministic.
      };

      socket.onclose = () => {
        if (ws === socket) {
          // If this was our active socket, treat it like a normal disconnect.
          ws = null;
          if (E2E_STATE) E2E_STATE.signalingConnected = false;

          if (transportOpen) {
            setStatus('Signaling disconnected (P2P active)');
            scheduleSignalingReconnect();
            return;
          }

          cleanup();
          return;
        }

        // If we never settled, this attempt failed.
        if (!settled) resolve(false);
      };
    });

    return ok;
  } finally {
    signalingReconnectInFlight = false;
  }
}

function connectSignaling(roomId, initiator) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(SIGNALING_URL);
    ws = socket;
    isInitiator = !!initiator;
    let settled = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: initiator ? 'create-room' : 'join-room',
        roomId,
      }));
    };

    socket.onmessage = async (e) => {
      if (ws !== socket) return;

      const msg = JSON.parse(e.data);

      if (msg.type === 'room-created' || msg.type === 'room-joined') {
        settled = true;
        activeRoomId = roomId;
        signalingReconnectAttempts = 0;
        if (E2E_STATE) E2E_STATE.signalingConnected = true;
        resolve();
        return;
      }

      if (msg.type === 'peer-joined' && initiator) {
        // Only negotiate a new connection if we don't already have one.
        if (!transport) {
          await startConnection();
        } else {
          setStatus('Peer joined signaling (P2P active)');
        }
        return;
      }

      if (msg.type === 'signal') {
        await handleSignal(msg.payload);
        return;
      }

      if (msg.type === 'peer-left') {
        if (transportOpen) {
          // Signaling presence is not authoritative once P2P is established.
          // Transport close is the source of truth.
          setStatus('Peer left signaling (P2P active)');
          return;
        }

        cleanup();
      }

      if (msg.type === 'error') {
        if (!settled) {
          settled = true;
          reject(new Error(msg.message));
          return;
        }
        // Already connected. Keep transport alive; surface message.
        setStatus(msg.message);
      }
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      if (!settled) {
        settled = true;
        reject(new Error('Signaling error'));
      }
    };

    socket.onclose = () => {
      if (ws !== socket) return;

      if (!settled) {
        settled = true;
        try { reject(new Error('Signaling closed')); } catch {}
        cleanup();
        return;
      }

      // After P2P is established, signaling should not be able to kill an
      // active transfer. Keep the WebRTC transport alive; just disable further
      // negotiation (ICE restart) until signaling returns.
      if (transportOpen) {
        ws = null;
        if (E2E_STATE) E2E_STATE.signalingConnected = false;
        setStatus('Signaling disconnected (P2P active)');
        scheduleSignalingReconnect();
        return;
      }

      cleanup();
    };
  });
}

function sendSignal(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', payload }));
  }
}

function sendApp(type, payload) {
  sendSignal({ app: { type, payload } });
}

/* ---------- Transport ---------- */

function onTransportControlFrame(data) {
  handleOutboundControlFrame(data).catch(() => {});
}

async function handleOutboundControlFrame(data) {
  // Control frames are extremely rare compared to CHUNK frames.
  // Early-filter by message type to avoid overhead on the hot path.
  const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (frame.byteLength < 9) return;

  const type = frame[0] & 0xff;
  if (type !== MSG_ABORT && type !== MSG_META) return;

  const transferId = frame.subarray(1, 9);

  // Passphrase verification handshake (encrypted META in reserved transferId domain).
  if (type === MSG_META && isHandshakeTransferId(transferId)) {
    await handleInboundHandshakeMetaFrame(frame, transferId);
    return;
  }

  const key = hexId(transferId);
  const entry = outboundTransfers.get(key);
  if (!entry) return;

  if (type === MSG_ABORT) {
    if (entry.receiptTimer) {
      try { clearTimeout(entry.receiptTimer); } catch {}
      entry.receiptTimer = null;
    }

    try { if (entry.row) entry.row.setStatus('aborted by peer'); } catch {}
    try { if (entry.sender) entry.sender.destroy(); } catch {}

    outboundTransfers.delete(key);
    return;
  }

  // META receipt frame: [type(1)] [transferId(8)] [flags(1)] [metaLen(2)] [metaPayload]
  if (frame.byteLength < 12) return;
  const flags = frame[9] & 0xff;
  const metaLen = ((frame[10] << 8) | frame[11]) >>> 0;
  if (metaLen > 4096) return;
  if (12 + metaLen !== frame.byteLength) return;

  let payload = frame.subarray(12, 12 + metaLen);
  const encrypted = (flags & META_FLAG_ENCRYPTED) !== 0;

  if (encrypted) {
    const passphrase = getLocalPassphrase();
    if (!passphrase) return;
    let aesKey = null;
    try {
      aesKey = await deriveAesGcmKey(passphrase, transferId);
    } catch {
      return;
    }

    try {
      payload = await decryptMeta(aesKey, transferId, flags, payload);
    } catch {
      return;
    }
  }

  let obj = null;
  try {
    obj = JSON.parse(_dec.decode(payload));
  } catch {
    return;
  }

  if (!obj || typeof obj !== 'object' || obj.v !== 1 || obj.kind !== 'receipt') return;

  const status = obj.status === 'ok' ? 'ok' : 'abort';
  const sink = obj.sink === 'saved' ? 'saved' : 'discarded';

  if (entry.receiptTimer) {
    try { clearTimeout(entry.receiptTimer); } catch {}
    entry.receiptTimer = null;
  }

  if (status === 'ok') {
    try { if (entry.row) entry.row.setStatus(sink === 'saved' ? 'delivered (saved)' : 'delivered (discarded)'); } catch {}
    entry.delivered = true;
    if (IS_E2E && E2E_STATE) {
      E2E_STATE.deliveredCount = (E2E_STATE.deliveredCount || 0) + 1;
      if (sink === 'saved') E2E_STATE.deliveredSavedCount = (E2E_STATE.deliveredSavedCount || 0) + 1;
      if (sink === 'discarded') E2E_STATE.deliveredDiscardCount = (E2E_STATE.deliveredDiscardCount || 0) + 1;
    }
  } else {
    try { if (entry.row) entry.row.setStatus('receiver aborted'); } catch {}
  }

  outboundTransfers.delete(key);
}

function createTransport() {
  transport = new EpheraTransport({
    sendCandidate: (candidate) => sendSignal({ candidate }),
  }, getIceServers() || undefined, getRtcConfig() || undefined);

  transport.onOpen = () => {
    transportOpen = true;
    transferSection.hidden = false;
    setStatus('P2P connected');
    renderPeerState();
    updateSendButton();
    if (E2E_STATE) E2E_STATE.transportOpen = true;
    maybeSendPassphraseHandshake('transport open').catch(() => {});
  };

  transport.onClose = cleanup;
  transport.onError = cleanup;
  transport.onState = handleTransportState;

  // Drain any candidates that arrived before transport existed.
  if (pendingIce.length > 0) {
    const list = pendingIce;
    pendingIce = [];
    for (const c of list) {
      transport.addIceCandidate(c).catch(() => {});
    }
  }

  initReceiver();

  // Listen for peer control frames (ABORT + META receipt) for outbound transfers.
  transport.addEventListener('chunk', onTransportControlFrame);
}

async function startConnection() {
  createTransport();
  const offer = await transport.createOffer();
  sendSignal({ sdp: offer });
}

async function handleSignal(payload) {
  if (payload && payload.app) {
    handleAppSignal(payload.app);
  }

  if (payload.sdp) {
    if (payload.sdp.type === 'offer') {
      if (!transport) createTransport();
      const answer = await transport.handleOffer(payload.sdp);
      sendSignal({ sdp: answer });
    } else {
      if (transport) {
        await transport.handleAnswer(payload.sdp);
        if (restartInFlight) {
          restartInFlight = false;
          if (E2E_STATE) E2E_STATE.restartInFlight = false;
          setStatus('P2P connected');
        }
      }
    }
  }

  if (payload.candidate) {
    if (transport) {
      await transport.addIceCandidate(payload.candidate);
    } else {
      // Candidate can arrive before offer in some networks.
      // Queue it until transport exists.
      if (pendingIce.length < 256) pendingIce.push(payload.candidate);
    }
  }
}

function handleAppSignal(app) {
  if (!app || typeof app.type !== 'string') return;

  if (app.type === 'ready') {
    peerReady = !!(app.payload && app.payload.value);
    peerCryptoMode = (app.payload && app.payload.cryptoMode === 'passphrase')
      ? 'passphrase'
      : 'none';

    renderPeerState();
    updateSendButton();
    maybeSendPassphraseHandshake('peer ready').catch(() => {});
    if (E2E_STATE) E2E_STATE.peerReady = peerReady;
    return;
  }

  if (app.type === 'meaning') {
    const mr = new MeaningReceiver();
    mr.onMeaning = (meaning) => {
      const parts = [];
      if (meaning.category) parts.push(meaning.category);
      if (meaning.sizeRange) parts.push(meaning.sizeRange);
      if (meaning.mimeHint) parts.push(meaning.mimeHint);
      peerMeaning = parts.join(' / ') || 'unknown';
      renderPeerState();
    };
    mr.handle(app.payload);
  }
}

function handleTransportState(e) {
  const state = e && e.iceConnectionState ? e.iceConnectionState : null;
  if (E2E_STATE) E2E_STATE.iceConnectionState = state;

  if (!state) return;
  if (!isInitiator) return;
  if (!transportOpen) return;

  // Attempt ICE restart if the connection looks unhealthy.
  if (state === 'failed') {
    triggerIceRestart('ice failed').catch(() => {});
    return;
  }

  if (state === 'disconnected') {
    // Give it a short window to self-heal; restart if it stays disconnected.
    if (restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!transport || transport.destroyed) return;
      if (!transport.pc) return;
      if (transport.pc.iceConnectionState !== 'disconnected') return;
      triggerIceRestart('ice disconnected').catch(() => {});
    }, 1500);
  }
}

async function triggerIceRestart(reason) {
  if (!isInitiator) return;
  if (restartInFlight) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Best-effort: try to regain signaling so ICE restart can happen.
    scheduleSignalingReconnect();
    return;
  }
  if (!transport || transport.destroyed) return;

  restartInFlight = true;
  if (E2E_STATE) {
    E2E_STATE.restartInFlight = true;
    E2E_STATE.restartCount = (E2E_STATE.restartCount || 0) + 1;
  }

  try {
    const offer = await transport.createOffer({ iceRestart: true });
    sendSignal({ sdp: offer });
    setStatus(`Reconnecting (${reason})`);
  } catch (err) {
    restartInFlight = false;
    if (E2E_STATE) E2E_STATE.restartInFlight = false;
    throw err;
  }
}

/* ---------- Sender ---------- */

function sendAdvisoryMeaning(file) {
  // Advisory meaning signal (one-shot, no retention)
  try {
    const ms = new MeaningSender((meaning) => sendApp('meaning', meaning));
    const size = Number(file && file.size) || 0;
    const sizeRange =
      size < 10 * 1024 * 1024 ? '<10MB'
        : size < 100 * 1024 * 1024 ? '10-100MB'
          : size < 1024 * 1024 * 1024 ? '100MB-1GB'
            : '1GB+';
    const category = (() => {
      const t = ((file && file.type) || '').toLowerCase();
      if (t.startsWith('image/')) return 'image';
      if (t.startsWith('audio/')) return 'audio';
      if (t.startsWith('video/')) return 'video';
      if (t.includes('pdf') || t.startsWith('text/')) return 'document';
      if (t.includes('zip') || t.includes('gzip') || t.includes('tar')) return 'archive';
      return 'other';
    })();
    ms.send({ mimeHint: file.type || null, category, sizeRange });
  } catch {}
}

async function startOutboundTransfer(file, { weight, passphrase, markE2E = false } = {}) {
  if (!file || !transport) return false;

  sendAdvisoryMeaning(file);

  const totalBytes = Number(file.size) || 0;
  let sentBytes = 0;
  let lastPct = null;
  let lastSpeedTs = (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
  let lastSpeedBytes = 0;
  let cancelled = false;

  const row = addTransferRow({
    direction: 'out',
    title: file.name || 'unnamed',
  });

  const srcReader = file.stream().getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      let readResult;
      try {
        readResult = await srcReader.read();
      } catch (err) {
        try { controller.error(err); } catch {}
        try { srcReader.releaseLock(); } catch {}
        return;
      }

      const { done, value } = readResult;
      if (done) {
        controller.close();
        try { srcReader.releaseLock(); } catch {}
        return;
      }

      const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
      sentBytes += u8.byteLength;
      row.setBytes(sentBytes);

      if (markE2E && E2E_STATE) E2E_STATE.sentBytes = sentBytes;
      if (IS_E2E && E2E_STATE) E2E_STATE.sentTotalBytes += u8.byteLength;

      const now = (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
      if (now - lastSpeedTs >= 250) {
        const dt = Math.max(0.001, (now - lastSpeedTs) / 1000);
        const db = Math.max(0, sentBytes - lastSpeedBytes);
        const bps = db / dt;
        row.setSpeed(`${formatBytes(bps)}/s`);
        lastSpeedTs = now;
        lastSpeedBytes = sentBytes;
      }

      if (!cancelled && totalBytes > 0) {
        const pct = Math.min(100, Math.floor((sentBytes / totalBytes) * 100));
        row.setProgress(pct);
        if (pct !== lastPct) {
          lastPct = pct;
          row.setStatus(`sending (${pct}%)`);
        }
      }

      controller.enqueue(u8);
    },

    cancel() {
      try {
        const p = srcReader.cancel();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
      try { srcReader.releaseLock(); } catch {}
    },
  });

  const localSender = new EpheraSender(transport, {
    weight,
    passphrase,
    meta: {
      name: file.name || null,
      type: file.type || null,
      size: totalBytes || null,
    },
  });
  activeSenders.add(localSender);

  row.setStatus('sending');
  row.setCancel(() => {
    cancelled = true;
    row.setStatus('cancelling');
    try { localSender.destroy(); } catch {}
  });

  // Start immediately so transferId is assigned synchronously.
  const startPromise = localSender.start(stream);
  const transferId = localSender.transferId;
  const transferKey = transferId ? hexId(transferId) : null;
  if (transferKey) {
    outboundTransfers.set(transferKey, {
      row,
      sender: localSender,
      receiptTimer: null,
      delivered: false,
    });
  }

  try {
    await startPromise;

    row.setBytes(totalBytes || sentBytes);
    if (totalBytes > 0) row.setProgress(100);
    row.setSpeed('');

    if (cancelled) {
      row.setStatus('cancelled');
      return false;
    }

    let awaitingReceipt = false;
    if (transferKey) {
      const entry = outboundTransfers.get(transferKey);
      if (entry) {
        // Release sender reference after successful send; keep row only until receipt or timeout.
        entry.sender = null;
        awaitingReceipt = true;

        entry.receiptTimer = setTimeout(() => {
          const cur = outboundTransfers.get(transferKey);
          if (!cur) return;
          if (!cur.delivered) {
            try { if (cur.row) cur.row.setStatus('sent (no receipt)'); } catch {}
          }
          outboundTransfers.delete(transferKey);
        }, RECEIPT_TIMEOUT_MS);
      }
    }

    row.setStatus(awaitingReceipt ? 'sent (awaiting receipt)' : 'sent');
    if (IS_E2E && E2E_STATE) E2E_STATE.sentDoneCount = (E2E_STATE.sentDoneCount || 0) + 1;
    if (markE2E && E2E_STATE) E2E_STATE.sentDone = true;
    return true;
  } catch (err) {
    if (cancelled) {
      row.setStatus('cancelled');
      return false;
    }

    row.setStatus('aborted');
    if (IS_E2E && E2E_STATE) E2E_STATE.sentAbortCount = (E2E_STATE.sentAbortCount || 0) + 1;
    if (IS_E2E && E2E_STATE && !E2E_STATE.error) {
      const detail = err && err.message ? err.message : 'send failed';
      const name = file && file.name ? file.name : 'unknown';
      E2E_STATE.error = `send failed (${name}): ${detail}`;
    }

    if (transferKey) {
      const entry = outboundTransfers.get(transferKey);
      if (entry && entry.receiptTimer) {
        try { clearTimeout(entry.receiptTimer); } catch {}
        entry.receiptTimer = null;
      }
      outboundTransfers.delete(transferKey);
    }
    return false;
  } finally {
    activeSenders.delete(localSender);
    row.setCancel(null);
  }
}

async function sendSelectedFile() {
  if (!transport) return;

  const all = Array.from(fileInput.files || []);
  if (all.length === 0) return;

  const MAX_FILES_PER_BATCH = 20;
  const files = all.slice(0, MAX_FILES_PER_BATCH);
  if (all.length > MAX_FILES_PER_BATCH) {
    setStatus(`Sending first ${MAX_FILES_PER_BATCH} files (selected ${all.length})`);
  } else {
    setStatus(`Sending ${files.length} transfer(s)`);
  }

  const weight = Number(sendWeightInput?.value || 1) || 1;
  const passphrase = getLocalPassphrase();

  fileInput.value = '';
  updateSendButton();

  // Start transfers on a new task so the click handler returns immediately,
  // even when many files are queued.
  const tasks = files.map((file, i) => new Promise((resolve) => {
    setTimeout(() => {
      startOutboundTransfer(file, { weight, passphrase, markE2E: IS_E2E && i === 0 })
        .then(resolve)
        .catch(() => resolve(false));
    }, 0);
  }));
  const results = await Promise.all(tasks);

  const ok = results.filter(Boolean).length;
  const fail = results.length - ok;
  setStatus(fail === 0 ? 'Sent' : `Send complete: ${ok} sent, ${fail} failed/cancelled`);
}

/* ---------- Receiver ---------- */

function initReceiver() {
  if (!transport) return;

  // Reset old layers if any (new transport)
  if (receiver) {
    receiver.destroy();
    receiver = null;
  }
  if (sessionManager) {
    sessionManager.handleClose();
    sessionManager.destroy();
    sessionManager = null;
  }

  receiver = new EpheraReceiver(transport);

  sessionManager = new SessionManager();

  receiver.onSessionEvent = (event) => sessionManager.handleEvent(event);

  sessionManager.onSession = (session) => {
    handleIncomingSession(session);
  };

  receiver.start();
}

async function handleIncomingSession(session) {
  if (IS_E2E && E2E_STATE && Array.isArray(E2E_STATE.sessionWeakRefs) && typeof WeakRef !== 'undefined') {
    try { E2E_STATE.sessionWeakRefs.push(new WeakRef(session)); } catch {}
  }

  const id = hexId(session.transferId);

  const row = addTransferRow({
    direction: 'in',
    title: id,
  });
  row.setStatus('receiving');

  const stream = session.getStream();
  if (!stream) {
    row.setStatus('aborted');
    return;
  }

  let cancelled = false;
  let bytes = 0;
  let expectedBytes = null;
  let lastPct = null;
  let lastSpeedTs = (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
  let lastSpeedBytes = 0;

  const reader = stream.getReader();
  let writable = null;
  let discard = false;
  let aesKey = null;
  let chunkIndex = 0;

  let abortSignaled = false;
  const signalAbortOnce = () => {
    if (abortSignaled) return;
    abortSignaled = true;
    sendPeerAbort(session.transferId);
  };

  const DEFAULT_NAME = `ephera-${id}.bin`;
  let saveName = DEFAULT_NAME;

  let metaEvent = null;
  let metaApplied = false;
  let metaFatal = null;

  async function maybeApplyMeta() {
    if (metaApplied) return;
    if (!metaEvent) return;

    metaApplied = true;

    const flags = (metaEvent.flags || 0) & 0xff;
    const encrypted = (flags & 0x01) !== 0;

    let payload = metaEvent.meta;
    if (!(payload instanceof Uint8Array)) return;

    if (encrypted) {
      const passphrase = getLocalPassphrase();
      if (!passphrase) {
        throw new Error('Encrypted transfer requires passphrase');
      }
      if (!aesKey) {
        // Not ready yet; allow a second attempt after key derivation.
        metaApplied = false;
        return;
      }
      payload = await decryptMeta(aesKey, session.transferId, flags, payload);
    }

    let obj = null;
    try {
      obj = JSON.parse(_dec.decode(payload));
    } catch {
      return;
    }

    if (!obj || typeof obj !== 'object' || obj.v !== 1) return;

    const safeName = sanitizeFileName(obj.name);
    if (safeName) {
      row.setTitle(safeName);
      if (E2E_STATE) E2E_STATE.recvTitle = safeName;
      if (IS_E2E && E2E_STATE && Array.isArray(E2E_STATE.recvTitles)) {
        E2E_STATE.recvTitles.push(safeName);
      }
      // Only use the suggested name if we haven't opened the output file yet.
      if (!writable) saveName = safeName;
    }

    if (Number.isFinite(obj.size) && obj.size >= 0) {
      expectedBytes = Math.floor(obj.size);
    }
  }

  session.onMeta = (e) => {
    metaEvent = e;
    maybeApplyMeta().catch((err) => { metaFatal = err; });
  };

  // META can arrive before app wiring attaches the callback.
  try {
    if (!metaEvent && session && typeof session.getMeta === 'function') {
      metaEvent = session.getMeta();
    }
  } catch {}

  row.setCancel(() => {
    cancelled = true;
    row.setStatus('cancelling');
    signalAbortOnce();
    try {
      if (writable) writable.abort();
    } catch {}
    try {
      const p = reader.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }, { label: 'Stop' });

  try {
    const passphrase = getLocalPassphrase();
    if (passphrase) {
      row.setStatus('deriving key');
      aesKey = await deriveAesGcmKey(passphrase, session.transferId);
    }

    // If META arrived while deriving, apply it now.
    await maybeApplyMeta();

    let outputName = saveName || DEFAULT_NAME;

    if (receiveDirHandle && typeof receiveDirHandle.getFileHandle === 'function') {
      let fileName = sanitizeFileName(saveName || DEFAULT_NAME) || DEFAULT_NAME;

      // Avoid overwriting existing files. If there's a collision, suffix with a short transfer id.
      const exists = async (name) => {
        try {
          await receiveDirHandle.getFileHandle(name, { create: false });
          return true;
        } catch {
          return false;
        }
      };

      if (await exists(fileName)) {
        const dot = fileName.lastIndexOf('.');
        const base = dot > 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot > 0 ? fileName.slice(dot) : '';
        const short = id.slice(0, 8);

        let candidate = sanitizeFileName(`${base} (${short})${ext}`) || DEFAULT_NAME;
        if (await exists(candidate)) {
          for (let i = 2; i <= 50; i++) {
            // eslint-disable-next-line no-await-in-loop
            const next = sanitizeFileName(`${base} (${short}-${i})${ext}`) || DEFAULT_NAME;
            // eslint-disable-next-line no-await-in-loop
            if (!(await exists(next))) {
              candidate = next;
              break;
            }
          }
        }

        fileName = candidate;
      }

      outputName = fileName;
      const fileHandle = await receiveDirHandle.getFileHandle(fileName, { create: true });
      writable = await fileHandle.createWritable();
      row.setTitle(fileName);
      row.setStatus(aesKey ? `decrypting + saving: ${fileName}` : `saving: ${fileName}`);
    } else {
      discard = true;
      row.setStatus(aesKey ? 'decrypting + discarding (no receive folder)' : 'discarding (no receive folder)');
    }

    const modeLabel = discard
      ? (aesKey ? 'decrypting + discarding (no receive folder)' : 'discarding (no receive folder)')
      : (aesKey ? `decrypting + saving: ${outputName}` : `saving: ${outputName}`);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (cancelled) break;

      if (metaFatal) throw metaFatal;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      let out = chunk;
      if (aesKey) {
        out = await decryptChunk(aesKey, session.transferId, chunkIndex, chunk);
        chunkIndex++;
      }

      bytes += out.byteLength;
      row.setBytes(bytes);
      if (E2E_STATE) E2E_STATE.recvBytes = bytes;
      if (IS_E2E && E2E_STATE) E2E_STATE.recvTotalBytes += out.byteLength;

      const now = (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
      if (now - lastSpeedTs >= 250) {
        const dt = Math.max(0.001, (now - lastSpeedTs) / 1000);
        const db = Math.max(0, bytes - lastSpeedBytes);
        const bps = db / dt;
        row.setSpeed(`${formatBytes(bps)}/s`);
        lastSpeedTs = now;
        lastSpeedBytes = bytes;
      }

      if (!discard && writable) {
        await writable.write(out);
      }

      if (expectedBytes && expectedBytes > 0) {
        const pct = Math.min(100, Math.floor((bytes / expectedBytes) * 100));
        row.setProgress(pct);
        if (pct !== lastPct) {
          lastPct = pct;
          row.setStatus(`${modeLabel} (${pct}%)`);
        }
      }

      if (IS_E2E && E2E_RECV_DELAY_MS > 0) {
        // Test-only slow consumer simulation.
        // This may trigger receiver backpressure overflow aborts by design.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, E2E_RECV_DELAY_MS));
      }
    }

    if (writable) {
      await writable.close();
      writable = null;
    }

    if (cancelled) {
      row.setStatus('cancelled');
      return;
    }

    if (aesKey) {
      row.setStatus(discard ? 'received (decrypted, discarded)' : 'received (decrypted, saved)');
    } else {
      row.setStatus(discard ? 'received (discarded)' : 'received (saved)');
    }
    if (expectedBytes && expectedBytes > 0) row.setProgress(100);
    row.setSpeed('');
    sendReceipt(session.transferId, {
      aesKey,
      status: 'ok',
      sink: discard ? 'discarded' : 'saved',
      bytes,
    }).catch(() => {});
    if (IS_E2E && E2E_STATE) E2E_STATE.recvDoneCount = (E2E_STATE.recvDoneCount || 0) + 1;
    if (E2E_STATE) E2E_STATE.recvDone = true;
  } catch (err) {
    row.setStatus(cancelled ? 'cancelled' : 'aborted');
    try {
      if (writable) await writable.abort();
    } catch {}
    try {
      const p = reader.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    if (!cancelled) signalAbortOnce();
    if (!cancelled && IS_E2E && E2E_STATE) E2E_STATE.recvAbortCount = (E2E_STATE.recvAbortCount || 0) + 1;
    if (!cancelled && E2E_STATE) E2E_STATE.error = err && err.message ? err.message : 'receive failed';
  } finally {
    try { reader.releaseLock(); } catch {}
    row.setCancel(null);
  }
}

/* ---------- Cleanup ---------- */

function cleanup() {
  transportOpen = false;
  peerReady = false;
  peerCryptoMode = 'none';
  resetPassphraseVerification();
  peerMeaning = null;
  localReady = false;
  isInitiator = false;
  activeRoomId = null;
  clearSignalingReconnect();
  if (E2E_STATE) E2E_STATE.signalingConnected = false;
  if (E2E_STATE) E2E_STATE.transportOpen = false;
  if (E2E_STATE) E2E_STATE.peerReady = false;
  if (E2E_STATE) E2E_STATE.iceConnectionState = null;
  restartInFlight = false;
  if (E2E_STATE) E2E_STATE.restartInFlight = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  receiveDirHandle = null;
  pendingIce = [];
  clearOutboundTransfers();

  // Cleanup structured layers first
  if (sessionManager) {
    // Channel death semantics: abort all active sessions immediately.
    sessionManager.handleClose();
    sessionManager.destroy();
    sessionManager = null;
  }

  // Cleanup protocol layer (detaches transport)
  if (receiver) {
    receiver.destroy();
    receiver = null;
  }

  // Cleanup active senders (may be multiple concurrent transfers)
  if (activeSenders.size > 0) {
    for (const s of activeSenders) {
      try { s.destroy(); } catch {}
    }
    activeSenders.clear();
  }

  // Cleanup transport (closes DataChannel)
  if (transport) {
    transport.destroy();
    transport = null;
  }

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  transferSection.hidden = true;
  createRoomBtn.disabled = false;
  joinRoomBtn.disabled = false;
  disconnectBtn.disabled = true;

  fileInput.value = '';
  if (sendWeightInput) sendWeightInput.value = '1';
  if (sendWeightValue) sendWeightValue.textContent = '1';
  if (transfersEl) transfersEl.textContent = '';
  updateSendButton();
  setReceiveFolderLabel('No folder selected');
  setPeerState('');
  setCryptoState('');
  if (passphraseInput) passphraseInput.value = '';
  if (sharePassphraseBtn) sharePassphraseBtn.disabled = true;
  if (includePassphraseLinkInput) includePassphraseLinkInput.checked = false;
  if (includeIceLinkInput) includeIceLinkInput.checked = false;
  iceServersOverride = null;
  if (iceServersJsonInput) iceServersJsonInput.value = '';
  setIceState('');
  setStatus('');

  // Ensure join link no longer contains any prior secret-bearing params.
  updateJoinLink();
}

/* ---------- Events ---------- */

fileInput.onchange = updateSendButton;

createRoomBtn.onclick = async () => {
  try { await RUNTIME_CONFIG_READY; } catch {}

  let roomId = roomIdInput.value.trim();
  if (!roomId) {
    roomId = generateRoomId();
    roomIdInput.value = roomId;
    updateJoinLink();
  }

  let autoGenerated = false;
  if (!getLocalPassphrase() && passphraseInput) {
    passphraseInput.value = generateEphemeralPassphrase();
    onPassphraseChanged();
    autoGenerated = true;
  }

  try {
    await connectSignaling(roomId, true);
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus(autoGenerated
      ? 'Waiting for peer (passphrase generated; share it)'
      : 'Waiting for peer (signaling room created)');
    if (E2E_STATE) E2E_STATE.signaling = 'room-created';
  } catch (err) {
    setStatus(err.message);
    if (E2E_STATE) E2E_STATE.error = err && err.message ? err.message : 'create room failed';
  }
};

joinRoomBtn.onclick = async () => {
  try { await RUNTIME_CONFIG_READY; } catch {}

  const roomId = roomIdInput.value.trim();
  if (!roomId) return;

  try {
    await connectSignaling(roomId, false);
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus('Joined room, waiting for offer');
    if (E2E_STATE) E2E_STATE.signaling = 'room-joined';

    // E2E automation: signal "ready" without requiring a folder picker.
    if (IS_E2E && E2E_AUTO_READY) {
      localReady = true;
      sendApp('ready', { value: true, cryptoMode: getLocalCryptoMode() });
      renderPeerState();
    }
  } catch (err) {
    setStatus(err.message);
    if (E2E_STATE) E2E_STATE.error = err && err.message ? err.message : 'join room failed';
  }
};

disconnectBtn.onclick = cleanup;
sendFileBtn.onclick = sendSelectedFile;
window.onbeforeunload = cleanup;

if (sendWeightInput && sendWeightValue) {
  sendWeightInput.oninput = () => {
    sendWeightValue.textContent = String(sendWeightInput.value);
  };
}

if (roomIdInput) {
  roomIdInput.oninput = () => {
    updateJoinLink();
  };
}

if (generateRoomIdBtn && roomIdInput) {
  generateRoomIdBtn.onclick = () => {
    roomIdInput.value = generateRoomId();
    updateJoinLink();
  };
}

if (copyJoinLinkBtn) {
  copyJoinLinkBtn.onclick = async () => {
    const link = joinLinkInput ? joinLinkInput.value : '';
    try {
      const ok = await copyText(link);
      setStatus(ok ? 'Join link copied' : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

if (shareJoinLinkBtn) {
  shareJoinLinkBtn.onclick = async () => {
    const link = joinLinkInput ? joinLinkInput.value : '';
    if (!link) {
      setStatus('No join link to share');
      return;
    }

    if (!CAN_SHARE) {
      try {
        const ok = await copyText(link);
        setStatus(ok ? 'Join link copied' : 'Copy failed');
      } catch {
        setStatus('Copy failed');
      }
      return;
    }

    try {
      await navigator.share({ title: 'Ephera', text: 'Ephera join link', url: link });
      setStatus('Shared');
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus('Share cancelled');
        return;
      }

      // Fallback to copy if share fails.
      try {
        const ok = await copyText(link);
        setStatus(ok ? 'Join link copied' : 'Share failed');
      } catch {
        setStatus('Share failed');
      }
    }
  };
}

if (copyPassphraseBtn) {
  copyPassphraseBtn.onclick = async () => {
    const p = getLocalPassphrase();
    if (!p) {
      setStatus('No passphrase to copy');
      return;
    }
    try {
      const ok = await copyText(p);
      setStatus(ok ? 'Passphrase copied' : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

if (sharePassphraseBtn) {
  sharePassphraseBtn.onclick = async () => {
    const p = getLocalPassphrase();
    if (!p) {
      setStatus('No passphrase to share');
      return;
    }

    if (!CAN_SHARE) {
      try {
        const ok = await copyText(p);
        setStatus(ok ? 'Passphrase copied' : 'Copy failed');
      } catch {
        setStatus('Copy failed');
      }
      return;
    }

    try {
      await navigator.share({ title: 'Ephera passphrase', text: p });
      setStatus('Shared');
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus('Share cancelled');
        return;
      }

      // Fallback to copy if share fails.
      try {
        const ok = await copyText(p);
        setStatus(ok ? 'Passphrase copied' : 'Share failed');
      } catch {
        setStatus('Share failed');
      }
    }
  };
}

function generateEphemeralPassphrase() {
  // 96-bit random => 24 hex chars, grouped for readability.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex.match(/.{1,4}/g).join('-');
}

function onPassphraseChanged() {
  resetPassphraseVerification();

  // Update UI and send button gating.
  renderPeerState();
  updateSendButton();
  updateJoinLink();
  if (sharePassphraseBtn) sharePassphraseBtn.disabled = !getLocalPassphrase();

  // If we're already "ready", update the peer with our crypto mode.
  if (localReady) {
    sendApp('ready', { value: true, cryptoMode: getLocalCryptoMode() });
  }

  // If we are already connected and the peer is in passphrase mode, attempt
  // verification immediately.
  maybeSendPassphraseHandshake('local passphrase changed').catch(() => {});
}

if (passphraseInput) {
  passphraseInput.oninput = onPassphraseChanged;
}

if (includePassphraseLinkInput) {
  includePassphraseLinkInput.onchange = () => {
    updateJoinLink();
  };
}

if (includeIceLinkInput) {
  includeIceLinkInput.onchange = () => {
    updateJoinLink();
  };
}

if (iceRelayOnlyInput) {
  iceRelayOnlyInput.onchange = () => {
    iceRelayOnly = !!iceRelayOnlyInput.checked;
    updateJoinLink();
    if (ws || transport) setStatus('ICE policy updated (reconnect to apply)');
  };
}

if (enableDiagnosticsInput) {
  enableDiagnosticsInput.onchange = () => {
    const enabled = !!enableDiagnosticsInput.checked;
    if (enabled) startDiagnostics();
    else stopDiagnostics();
  };
}

if (copyDiagnosticsBtn) {
  copyDiagnosticsBtn.onclick = async () => {
    const text = lastDiagnosticsText;
    if (!text) {
      setStatus('No diagnostics to copy');
      return;
    }
    try {
      const ok = await copyText(text);
      setStatus(ok ? 'Diagnostics copied' : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

function onIceServersChanged() {
  if (!iceServersJsonInput) return;

  const raw = iceServersJsonInput.value.trim();
  if (!raw) {
    iceServersOverride = null;
    setIceState('');
    updateJoinLink();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const sanitized = sanitizeIceServers(parsed);
    if (!sanitized) throw new Error('invalid');
    iceServersOverride = sanitized;
    setIceState(`ICE servers: ${sanitized.length}`);
  } catch {
    iceServersOverride = null;
    setIceState('Invalid ICE servers JSON');
  }

  updateJoinLink();
}

if (iceServersJsonInput) {
  iceServersJsonInput.onchange = onIceServersChanged;
}

if (generatePassphraseBtn && passphraseInput) {
  generatePassphraseBtn.onclick = () => {
    passphraseInput.value = generateEphemeralPassphrase();
    onPassphraseChanged();
  };
}

if (clearPassphraseBtn && passphraseInput) {
  clearPassphraseBtn.onclick = () => {
    passphraseInput.value = '';
    onPassphraseChanged();
  };
}

if (pickReceiveFolderBtn) {
  pickReceiveFolderBtn.onclick = async () => {
    if (typeof window.showDirectoryPicker !== 'function') {
      if (!window.isSecureContext) {
        setStatus('Folder saving requires a secure context (https). Use Ready (Discard) or run dev:secure.');
      } else {
        setStatus('This browser does not support streaming receive folders. Use Ready (Discard) to receive without saving.');
      }
      return;
    }

    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      // Attempt to secure permission early.
      if (typeof dir.requestPermission === 'function') {
        try { await dir.requestPermission({ mode: 'readwrite' }); } catch {}
      }
      receiveDirHandle = dir;
      localReady = true;
      setReceiveFolderLabel('Receive folder set');
      sendApp('ready', { value: true, cryptoMode: getLocalCryptoMode() });
      // Locally we are "ready"; peer readiness is separate.
      setStatus('Ready to receive');
    } catch (err) {
      // User cancelled or permission denied.
      setStatus(err && err.message ? err.message : 'Receive folder not set');
    }
  };
}

if (readyDiscardBtn) {
  readyDiscardBtn.onclick = () => {
    receiveDirHandle = null;
    localReady = true;
    setReceiveFolderLabel('Ready: discard mode');
    sendApp('ready', { value: true, cryptoMode: getLocalCryptoMode() });
    setStatus('Ready to receive (discarding)');
  };
}

/* ---------- E2E Automation (Test-Only) ---------- */

if (IS_E2E) {
  const roomId = PARAMS.get('roomId');
  if (roomId) roomIdInput.value = roomId;

  const passphrase = PARAMS.get('passphrase');
  if (passphrase && passphraseInput) {
    passphraseInput.value = passphrase;
    onPassphraseChanged();
    stripPassphraseFromUrl();
  }

  if (ICE_POLICY === 'relay' && iceRelayOnlyInput) {
    iceRelayOnly = true;
    iceRelayOnlyInput.checked = true;
  }

  const hasIcePolicy = PARAMS.has('icePolicy');
  const hasIceServers = hasIceServersInParams(PARAMS);

  const hasIce = hasIcePolicy || hasIceServers;
  if (hasIceServers && iceServersJsonInput) {
    try {
      if (ICE_SERVERS) {
        iceServersJsonInput.value = JSON.stringify(ICE_SERVERS, null, 2);
        onIceServersChanged();
      } else {
        setIceState('Invalid ICE config in URL');
      }
    } catch {}
  }
  if (hasIce) {
    try { stripIceFromUrl(); } catch {}
  }

  if (E2E_STATE) {
    // Expose a minimal API for automation only.
    E2E_STATE.restartIce = () => triggerIceRestart('e2e');
    E2E_STATE.getBufferedAmount = () => {
      try {
        const ch = transport && transport.channel ? transport.channel : null;
        const n = ch && typeof ch.bufferedAmount === 'number' ? ch.bufferedAmount : 0;
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    };
    E2E_STATE.closeSignaling = () => {
      try { if (ws) ws.close(); } catch {}
    };
    E2E_STATE.disconnect = () => {
      try { disconnectBtn.click(); } catch {}
    };
  }

  if (E2E_ROLE === 'create') {
    createRoomBtn.click();
  } else if (E2E_ROLE === 'join') {
    joinRoomBtn.click();
  }
}

// Normal mode: prefill from share link.
if (!IS_E2E) {
  const roomId = PARAMS.get('roomId');
  if (roomId && roomIdInput) roomIdInput.value = roomId;

  const passphrase = PARAMS.get('passphrase');
  if (passphrase && passphraseInput) {
    passphraseInput.value = passphrase;
    onPassphraseChanged();
    stripPassphraseFromUrl();
  }

  if (ICE_POLICY === 'relay' && iceRelayOnlyInput) {
    iceRelayOnly = true;
    iceRelayOnlyInput.checked = true;
  }

  const hasIcePolicy = PARAMS.has('icePolicy');
  const hasIceServers = hasIceServersInParams(PARAMS);

  const hasIce = hasIcePolicy || hasIceServers;
  if (hasIceServers && iceServersJsonInput) {
    try {
      if (ICE_SERVERS) {
        iceServersJsonInput.value = JSON.stringify(ICE_SERVERS, null, 2);
        onIceServersChanged();
      } else {
        setIceState('Invalid ICE config in URL');
      }
    } catch {}
  }
  if (hasIce) {
    try { stripIceFromUrl(); } catch {}
  }

  updateJoinLink();
  renderPeerState();

  const autoJoin = PARAMS.get('autojoin') === '1' || PARAMS.has('autojoin');
  if (autoJoin && joinRoomBtn && !ws) {
    // Avoid auto-ready. Joining is safe; receiving still requires explicit action.
    joinRoomBtn.click();
  }
}
