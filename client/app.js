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
import { buildLocalCapabilities, sanitizeCapabilities, evaluateCapabilityCompatibility } from './capabilities.js';
import { INVITE_PACKAGE_ACCEPT_TEXT, sanitizeRoomJoinKey, parseInvitePackageText } from './invite-package.js';
import { buildInviteQrPayload } from './invite-qr.js';

const _dec = new TextDecoder();
const _enc = new TextEncoder();

const PARAMS = new URLSearchParams(location.search);
const HASH_PARAMS = (() => {
  try {
    const raw = String(location.hash || '').replace(/^#/, '').trim();
    if (!raw) return new URLSearchParams();
    return new URLSearchParams(raw);
  } catch {
    return new URLSearchParams();
  }
})();
const IS_E2E = PARAMS.get('e2e') === '1' || PARAMS.has('e2e');
const E2E_ROLE = PARAMS.get('role'); // 'create' | 'join'
const E2E_AUTO_READY = PARAMS.get('autoReady') === '1' || PARAMS.has('autoReady');
const FORCE_NO_FOLDER_UPLOAD = PARAMS.get('noFolderUpload') === '1' || PARAMS.has('noFolderUpload');
const E2E_RECV_DELAY_MS = (() => {
  if (!IS_E2E) return 0;
  const raw = Number(PARAMS.get('recvDelayMs') || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1000, Math.max(0, Math.floor(raw)));
})();
const QR_SCAN_MODE = (() => {
  const raw = String(PARAMS.get('qrScanMode') || '').trim().toLowerCase();
  if (raw === 'detector' || raw === 'jsqr') return raw;
  return 'auto';
})();

function parseProtocolParam(name, fallback) {
  const raw = PARAMS.get(name);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < 1) return fallback;
  return v;
}

function parseFeatureParam(name, fallbackList = []) {
  const raw = PARAMS.get(name);
  if (raw == null) {
    if (Array.isArray(fallbackList)) return Array.from(fallbackList);
    return [];
  }
  const s = String(raw).trim();
  if (!s) return [];
  return s.split(',').map((v) => String(v || '').trim()).filter(Boolean);
}

const localCapabilityOverrides = {};
if (PARAMS.has('protoVersion')) localCapabilityOverrides.protocolVersion = parseProtocolParam('protoVersion', null);
if (PARAMS.has('protoMin')) localCapabilityOverrides.minSupported = parseProtocolParam('protoMin', null);
if (PARAMS.has('protoFeatures')) localCapabilityOverrides.features = parseFeatureParam('protoFeatures');
if (PARAMS.has('protoRequired')) localCapabilityOverrides.requiredFeatures = parseFeatureParam('protoRequired');
const LOCAL_CAPABILITIES = buildLocalCapabilities(localCapabilityOverrides);

const E2E_STATE = IS_E2E ? (window.__epheraE2E = {
  role: E2E_ROLE || null,
  signalingConnected: false,
  signalingReconnects: 0,
  transportOpen: false,
  peerReady: false,
  capabilitiesCompatible: false,
  compatibilityReason: 'Protocol negotiation pending',
  localProtocolVersion: LOCAL_CAPABILITIES.protocolVersion,
  peerProtocolVersion: null,
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
  peerId: null,
  roomOwnerPeerId: null,
  localRole: 'none',
  roomKeyRotatedCount: 0,
  roomOwnerChangedCount: 0,
  roomClosedCount: 0,
  flowStep: 1,
  flowReady: false,
  quickSummary: '',
  transferAdvancedOpen: false,
  onboardingHint: '',
  onboardingRole: 'none',
  receiveDestinationMode: 'discard',
  receiveDestinationLabel: '',
  receiveDestinationPath: '',
  canOpenReceiveFolder: false,
  lastInboundOutcome: '',
  preflightSecureContext: false,
  preflightDirectoryPicker: false,
  preflightFolderSaveCapable: false,
  preflightSenderFolderUploadCapable: false,
  preflightWebRTC: false,
  preflightClipboard: false,
  preflightSummary: '',
  preflightFix: '',
  preflightOverall: false,
  launchpadState: '',
  launchpadHint: '',
  invitePackageReady: false,
  invitePackageAppliedCount: 0,
  invitePackageParseState: '',
  qrPayload: '',
  qrVisible: false,
  qrScanSupported: false,
  qrScanMode: '',
  qrScanEngine: '',
  qrLastScanSource: '',
  qrLastScanStatus: '',
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
  // in-memory param stores to avoid accidental persistence.
  try {
    if (!PARAMS.has('passphrase') && !HASH_PARAMS.has('passphrase')) return;
    const url = new URL(location.href);
    url.searchParams.delete('passphrase');
    const hash = new URLSearchParams(String(url.hash || '').replace(/^#/, ''));
    hash.delete('passphrase');
    url.hash = hash.toString() ? `#${hash.toString()}` : '';
    PARAMS.delete('passphrase');
    HASH_PARAMS.delete('passphrase');
    history.replaceState(null, '', url.toString());
  } catch {}
}

function stripRoomJoinKeyFromUrl() {
  // If a share link contained room auth key material, remove it from the
  // address bar and in-memory params to reduce accidental persistence.
  try {
    if (
      !PARAMS.has('roomJoinKey')
      && !PARAMS.has('joinKey')
      && !HASH_PARAMS.has('roomJoinKey')
      && !HASH_PARAMS.has('joinKey')
    ) return;
    const url = new URL(location.href);
    url.searchParams.delete('roomJoinKey');
    url.searchParams.delete('joinKey');
    const hash = new URLSearchParams(String(url.hash || '').replace(/^#/, ''));
    hash.delete('roomJoinKey');
    hash.delete('joinKey');
    url.hash = hash.toString() ? `#${hash.toString()}` : '';
    PARAMS.delete('roomJoinKey');
    PARAMS.delete('joinKey');
    HASH_PARAMS.delete('roomJoinKey');
    HASH_PARAMS.delete('joinKey');
    history.replaceState(null, '', url.toString());
  } catch {}
}

function getSecretParam(...names) {
  for (const name of names) {
    if (HASH_PARAMS.has(name)) {
      const v = HASH_PARAMS.get(name);
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  for (const name of names) {
    if (PARAMS.has(name)) {
      const v = PARAMS.get(name);
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
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

const appRootEl = document.querySelector('.app');
const landingShellEl = document.getElementById('landing-shell');
const dashboardShellEl = document.getElementById('dashboard-shell');
const landingSectionEls = Array.from(document.querySelectorAll('[data-landing-section]'));
const openDashboardEls = Array.from(document.querySelectorAll('[data-open-dashboard]'));
const returnLandingEls = Array.from(document.querySelectorAll('[data-return-landing]'));
const productSignalLabelEl = document.getElementById('product-signal-label');
const productSignalMetaEl = document.getElementById('product-signal-meta');
const workspaceHeaderEl = document.querySelector('.workspace-header');
const workspaceTitleEl = document.getElementById('workspace-title');
const workspaceBadgeEl = document.getElementById('workspace-badge');
const workspaceSubtitleEl = document.getElementById('workspace-subtitle');
const consoleNavEl = document.querySelector('.console-nav');
const workspaceSideColumnEl = document.querySelector('.workspace-column-side');
const workspaceSpotlightEl = document.getElementById('workspace-spotlight');
const phaseStatePillEl = document.getElementById('phase-state-pill');
const phaseBriefTitleEl = document.getElementById('phase-brief-title');
const phaseBriefCopyEl = document.getElementById('phase-brief-copy');
const phaseNextTitleEl = document.getElementById('phase-next-title');
const phaseNextCopyEl = document.getElementById('phase-next-copy');
const phaseNoteBoundaryEl = document.getElementById('phase-note-boundary');
const phaseNoteActionEl = document.getElementById('phase-note-action');
const phaseNoteUnlockEl = document.getElementById('phase-note-unlock');
const phaseNodeOnboardingEl = document.getElementById('phase-node-onboarding');
const phaseNodeSessionEl = document.getElementById('phase-node-session');
const phaseNodeChannelEl = document.getElementById('phase-node-channel');
const phaseNodeCockpitEl = document.getElementById('phase-node-cockpit');

const defaultDashboardView = (() => {
  if (PARAMS.get('dashboard') === '1') return true;
  if (PARAMS.get('view') === 'dashboard') return true;
  if (PARAMS.get('autojoin') === '1') return true;
  if (String(PARAMS.get('roomId') || '').trim()) return true;
  try {
    return !!(navigator && navigator.webdriver);
  } catch {
    return false;
  }
})();

const roomIdInput = document.getElementById('room-id');
const generateRoomIdBtn = document.getElementById('generate-room-id');
const roomJoinKeyInput = document.getElementById('room-join-key');
const generateRoomJoinKeyBtn = document.getElementById('generate-room-join-key');
const rotateRoomKeyBtn = document.getElementById('rotate-room-key');
const closeRoomBtn = document.getElementById('close-room');
const roomAuthorityEl = document.getElementById('room-authority');
const createRoomBtn = document.getElementById('create-room');
const joinRoomBtn = document.getElementById('join-room');
const disconnectBtn = document.getElementById('disconnect');
const joinLinkInput = document.getElementById('join-link');
const copyJoinLinkBtn = document.getElementById('copy-join-link');
const shareJoinLinkBtn = document.getElementById('share-join-link');
const launchpadStateEl = document.getElementById('launchpad-state');
const launchpadHintEl = document.getElementById('launchpad-hint');
const launchpadHostBtn = document.getElementById('launchpad-host');
const launchpadJoinBtn = document.getElementById('launchpad-join');
const copyInvitePackageBtn = document.getElementById('copy-invite-package');
const invitePackageInput = document.getElementById('invite-package-input');
const pasteInvitePackageBtn = document.getElementById('paste-invite-package');
const applyInvitePackageBtn = document.getElementById('apply-invite-package');
const applyJoinInvitePackageBtn = document.getElementById('apply-join-invite-package');
const invitePackageStateEl = document.getElementById('invite-package-state');
const showInviteQrBtn = document.getElementById('show-invite-qr');
const clearInviteQrBtn = document.getElementById('clear-invite-qr');
const scanQrImageBtn = document.getElementById('scan-qr-image');
const scanQrImageInput = document.getElementById('scan-qr-image-input');
const startQrCameraBtn = document.getElementById('start-qr-camera');
const stopQrCameraBtn = document.getElementById('stop-qr-camera');
const inviteQrCanvas = document.getElementById('invite-qr-canvas');
const qrCameraPreview = document.getElementById('qr-camera-preview');
const qrPairingStateEl = document.getElementById('qr-pairing-state');

const transferSection = document.getElementById('transfer-controls');
const transferLockBannerEl = document.getElementById('transfer-lock-banner');
const transferLockStateEl = document.getElementById('transfer-lock-state');
const transferLockTextEl = document.getElementById('transfer-lock-text');
const pickReceiveFolderBtn = document.getElementById('pick-receive-folder');
const readyDiscardBtn = document.getElementById('ready-discard');
const receiveFolderLabel = document.getElementById('receive-folder-label');
const receiveDestinationStateEl = document.getElementById('receive-destination-state');
const copyReceiveDestinationBtn = document.getElementById('copy-receive-destination');
const openReceiveFolderBtn = document.getElementById('open-receive-folder');
const peerStateEl = document.getElementById('peer-state');
const receiveCardEl = document.getElementById('receive-card');
const receiveActionStateEl = document.getElementById('receive-action-state');
const receiveActionCopyEl = document.getElementById('receive-action-copy');
const receiveStageTitleEl = document.getElementById('receive-stage-title');
const receiveStageTextEl = document.getElementById('receive-stage-text');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const pickSendFolderBtn = document.getElementById('pick-send-folder');
const sendFileBtn = document.getElementById('send-file');
const sendGateReasonEl = document.getElementById('send-gate-reason');
const sendCardEl = document.getElementById('send-card');
const sendActionStateEl = document.getElementById('send-action-state');
const sendActionCopyEl = document.getElementById('send-action-copy');
const sendStageTitleEl = document.getElementById('send-stage-title');
const sendStageTextEl = document.getElementById('send-stage-text');
const sendSelectionSummaryEl = document.getElementById('send-selection-summary');
const sendChipRoomEl = document.getElementById('send-chip-room');
const sendChipP2PEl = document.getElementById('send-chip-p2p');
const sendChipPeerEl = document.getElementById('send-chip-peer');
const sendChipCryptoEl = document.getElementById('send-chip-crypto');
const sendDropzoneEl = document.getElementById('send-dropzone');
const sendDropzoneTitleEl = document.getElementById('send-dropzone-title');
const sendDropzoneHintEl = document.getElementById('send-dropzone-hint');
const sendWeightInput = document.getElementById('send-weight');
const sendWeightValue = document.getElementById('send-weight-value');
const transfersEl = document.getElementById('transfers');
const activityTimelineEl = document.getElementById('activity-timeline');
const clearActivityBtn = document.getElementById('clear-activity');
const activitySearchInput = document.getElementById('activity-search');
const activityKindConnInput = document.getElementById('activity-kind-conn');
const activityKindTransferInput = document.getElementById('activity-kind-transfer');
const activityKindReceiptInput = document.getElementById('activity-kind-receipt');
const activityKindWarnInput = document.getElementById('activity-kind-warn');
const activityKindStatusInput = document.getElementById('activity-kind-status');
const activityKindsAllBtn = document.getElementById('activity-kinds-all');
const activityKindsNoneBtn = document.getElementById('activity-kinds-none');
const copyActivityBtn = document.getElementById('copy-activity');
const downloadActivityTxtBtn = document.getElementById('download-activity-txt');
const downloadActivityJsonBtn = document.getElementById('download-activity-json');
const activityCountEl = document.getElementById('activity-count');
const transferLedgerListEl = document.getElementById('transfer-ledger-list');
const clearTransferLedgerBtn = document.getElementById('clear-transfer-ledger');
const transferLedgerActiveCountEl = document.getElementById('transfer-ledger-active-count');
const transferLedgerCompleteCountEl = document.getElementById('transfer-ledger-complete-count');
const transferLedgerAttentionCountEl = document.getElementById('transfer-ledger-attention-count');
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
const stateSignalingEl = document.getElementById('state-signaling');
const stateP2PEl = document.getElementById('state-p2p');
const stateReadyEl = document.getElementById('state-ready');
const stateCryptoEl = document.getElementById('state-crypto');
const stateOwnerEl = document.getElementById('state-owner');
const preflightSummaryEl = document.getElementById('preflight-summary');
const preflightSecureStateEl = document.getElementById('preflight-secure-state');
const preflightFolderStateEl = document.getElementById('preflight-folder-state');
const preflightWebrtcStateEl = document.getElementById('preflight-webrtc-state');
const preflightClipboardStateEl = document.getElementById('preflight-clipboard-state');
const preflightFixEl = document.getElementById('preflight-fix');
const transferQuickSummaryEl = document.getElementById('transfer-quick-summary');
const transferAdvancedDetailsEl = document.getElementById('transfer-advanced');
const operatorConsoleDetailsEl = document.getElementById('operator-console');
const roleOnboardingHintEl = document.getElementById('role-onboarding-hint');
const flowCurrentEl = document.getElementById('flow-current');
const flowNextEl = document.getElementById('flow-next');
const flowStepRoomEl = document.getElementById('flow-step-room');
const flowStepP2PEl = document.getElementById('flow-step-p2p');
const flowStepLocalReadyEl = document.getElementById('flow-step-local-ready');
const flowStepPeerReadyEl = document.getElementById('flow-step-peer-ready');
const flowStepSendEl = document.getElementById('flow-step-send');
const consoleNavLinks = Array.from(document.querySelectorAll('[data-console-link]'));

function setActiveConsoleLink(hash) {
  if (!consoleNavLinks || consoleNavLinks.length < 1) return;
  for (let i = 0; i < consoleNavLinks.length; i++) {
    const link = consoleNavLinks[i];
    const active = link && typeof link.hash === 'string' && link.hash === hash;
    link.classList.toggle('console-nav-link-active', !!active);
  }
}

function initConsoleNav() {
  if (!consoleNavLinks || consoleNavLinks.length < 1) return;

  const targets = consoleNavLinks
    .map((link) => {
      const hash = link && typeof link.hash === 'string' ? link.hash : '';
      const id = hash.startsWith('#') ? hash.slice(1) : '';
      if (!id) return null;
      const el = document.getElementById(id);
      return el ? { hash, el } : null;
    })
    .filter(Boolean);

  if (targets.length < 1) return;

  const pickFromScroll = () => {
    let best = targets[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      const rect = item.el.getBoundingClientRect();
      const distance = Math.abs(rect.top - 120);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    setActiveConsoleLink(best.hash);
  };

  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      let bestEntry = null;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.isIntersecting) continue;
        if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) bestEntry = entry;
      }
      if (!bestEntry) {
        pickFromScroll();
        return;
      }
      const match = targets.find((item) => item.el === bestEntry.target);
      if (match) setActiveConsoleLink(match.hash);
    }, {
      rootMargin: '-18% 0px -55% 0px',
      threshold: [0.2, 0.45, 0.7],
    });

    for (let i = 0; i < targets.length; i++) observer.observe(targets[i].el);
  } else {
    window.addEventListener('scroll', pickFromScroll, { passive: true });
  }

  window.addEventListener('hashchange', () => {
    const next = window.location.hash || targets[0].hash;
    setActiveConsoleLink(next);
  });

  setActiveConsoleLink(window.location.hash || targets[0].hash);
}

/* ---------- State ---------- */

let ws = null;
let transport = null;
let receiver = null;
let sessionManager = null;
let transportOpen = false;
let peerReady = false;
let peerCapabilities = null;
let capabilitiesCompatible = false;
let compatibilityReason = 'Protocol negotiation pending';
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
let activeRoomJoinKey = null;
let localPeerId = null;
let roomOwnerPeerId = null;
let localRoomRole = 'none'; // 'none' | 'owner' | 'peer'
let lastInviteQrPayload = '';
let qrCameraStream = null;
let qrScanTimer = null;
let qrScanInFlight = false;

// Allow multiple concurrent outbound transfers (Stage 3/4 engine supports this).
const activeSenders = new Set();
let pendingOutboundEntries = [];
let pendingOutboundSource = 'none'; // 'none' | 'files' | 'folder'
let sendDropzoneDragDepth = 0;

// Track outbound transfers by transferId so we can:
// - abort sending if the receiver requests it (peer ABORT)
// - mark "delivered" when the receiver sends a receipt META
const outboundTransfers = new Map(); // Map<string(hexId), { row, sender, receiptTimer, delivered }>
const ACTIVITY_LIMIT = 240;
const activityEntries = [];
let activitySeq = 0;
let lastStatusText = '';
let lastIceState = null;
const TRANSFER_LEDGER_LIMIT = 40;
const transferLedgerEntries = [];
let transferLedgerSeq = 0;
const QR_DETECTOR_SUPPORTED = typeof BarcodeDetector === 'function';
const QR_JSQR_SUPPORTED = typeof window !== 'undefined' && typeof window.jsQR === 'function';
const QR_SCAN_SUPPORTED = QR_DETECTOR_SUPPORTED || QR_JSQR_SUPPORTED;
if (E2E_STATE) {
  E2E_STATE.qrScanSupported = QR_SCAN_SUPPORTED;
  E2E_STATE.qrScanMode = QR_SCAN_MODE;
}

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

function formatActivityTime(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function normalizeActivityMessage(message) {
  const s = typeof message === 'string' ? message.trim() : '';
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ');
  if (oneLine.length <= 220) return oneLine;
  return `${oneLine.slice(0, 217)}...`;
}

function mapActivityKind(kind) {
  const k = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (k === 'conn' || k === 'transfer' || k === 'receipt' || k === 'warn') return k;
  return 'status';
}

function inferActivityKindFromStatus(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'status';
  if (t.includes('error') || t.includes('failed') || t.includes('abort') || t.includes('cancel')) return 'warn';
  if (t.includes('delivery') || t.includes('delivered') || t.includes('receipt')) return 'receipt';
  if (t.includes('send') || t.includes('receive') || t.includes('transfer')) return 'transfer';
  if (t.includes('signaling') || t.includes('p2p') || t.includes('ice') || t.includes('reconnect') || t.includes('joined room') || t.includes('waiting for peer')) return 'conn';
  return 'status';
}

function isActivityKindEnabled(kind) {
  if (kind === 'conn') return !activityKindConnInput || !!activityKindConnInput.checked;
  if (kind === 'transfer') return !activityKindTransferInput || !!activityKindTransferInput.checked;
  if (kind === 'receipt') return !activityKindReceiptInput || !!activityKindReceiptInput.checked;
  if (kind === 'warn') return !activityKindWarnInput || !!activityKindWarnInput.checked;
  return !activityKindStatusInput || !!activityKindStatusInput.checked;
}

function getActivityQuery() {
  const raw = activitySearchInput ? String(activitySearchInput.value || '') : '';
  return raw.trim().toLowerCase();
}

function isActivityEntryVisible(entry, query) {
  if (!entry || typeof entry !== 'object') return false;
  if (!isActivityKindEnabled(entry.kind)) return false;
  if (!query) return true;
  return String(entry.msg || '').toLowerCase().includes(query);
}

function getVisibleActivityEntries() {
  const query = getActivityQuery();
  const out = [];
  const total = activityEntries.length;
  for (let i = 0; i < total; i++) {
    const entry = activityEntries[i];
    if (!isActivityEntryVisible(entry, query)) continue;
    out.push(entry);
  }
  return out;
}

function buildActivityRow(entry) {
  const row = document.createElement('div');
  row.className = 'activity-item';

  const time = document.createElement('span');
  time.className = 'activity-time';
  time.textContent = formatActivityTime(entry.ts);

  const tag = document.createElement('span');
  tag.className = `activity-kind activity-kind-${entry.kind}`;
  tag.textContent = entry.kind;

  const body = document.createElement('span');
  body.className = 'activity-msg';
  body.textContent = entry.msg;

  row.appendChild(time);
  row.appendChild(tag);
  row.appendChild(body);
  return row;
}

function renderActivityTimeline({ autoScroll = false } = {}) {
  if (!activityTimelineEl) return;

  const visibleEntries = getVisibleActivityEntries();
  activityTimelineEl.textContent = '';

  for (let i = 0; i < visibleEntries.length; i++) {
    const row = buildActivityRow(visibleEntries[i]);
    activityTimelineEl.appendChild(row);
  }

  if (activityCountEl) {
    activityCountEl.textContent = `Showing ${visibleEntries.length}/${activityEntries.length}`;
  }

  if (autoScroll) {
    try {
      activityTimelineEl.scrollTop = activityTimelineEl.scrollHeight;
    } catch {}
  }
}

function clearActivityTimeline() {
  activityEntries.length = 0;
  renderActivityTimeline();
}

function isLedgerTransferFinalOk(state) {
  return (
    state === 'delivered-saved'
    || state === 'delivered-discarded'
    || state === 'received-saved'
    || state === 'received-discarded'
  );
}

function isLedgerTransferAttention(state) {
  return (
    state === 'aborted'
    || state === 'cancelled'
    || state === 'receiver-aborted'
    || state === 'receipt-abort'
    || state === 'receipt-timeout'
    || state === 'blocked'
  );
}

function computeLedgerEntrySnapshot(entry) {
  const transfers = Array.isArray(entry && entry.transfers) ? entry.transfers : [];
  const payloadCount = Math.max(0, transfers.length || Number(entry && entry.count) || 0);
  const totalBytes = transfers.reduce((sum, item) => sum + Math.max(0, Number(item && item.totalBytes) || 0), 0)
    || Math.max(0, Number(entry && entry.totalBytes) || 0);
  const bytesDone = transfers.reduce((sum, item) => sum + Math.max(0, Number(item && item.bytes) || 0), 0);
  let okCount = 0;
  let attentionCount = 0;

  for (let i = 0; i < transfers.length; i++) {
    const state = String(transfers[i] && transfers[i].state || '').trim();
    if (isLedgerTransferFinalOk(state)) okCount++;
    else if (isLedgerTransferAttention(state)) attentionCount++;
  }

  const activeCount = Math.max(0, payloadCount - okCount - attentionCount);
  let status = 'live';
  if (activeCount > 0) {
    status = attentionCount > 0 ? 'attention' : 'live';
  } else if (attentionCount > 0) {
    status = okCount > 0 ? 'partial' : 'attention';
  } else if (payloadCount > 0) {
    status = 'complete';
  }

  const progress = totalBytes > 0
    ? Math.max(0, Math.min(100, Math.floor((bytesDone / totalBytes) * 100)))
    : (payloadCount > 0 ? Math.max(0, Math.min(100, Math.floor((okCount / payloadCount) * 100))) : 0);

  return {
    payloadCount,
    totalBytes,
    bytesDone,
    okCount,
    attentionCount,
    activeCount,
    status,
    progress,
  };
}

function isLedgerEntryActive(entry) {
  const snap = computeLedgerEntrySnapshot(entry);
  return snap.activeCount > 0;
}

function pruneTransferLedger() {
  if (transferLedgerEntries.length <= TRANSFER_LEDGER_LIMIT) return;

  // Never evict in-flight entries. If overflow contains active transfers only,
  // keep the overflow until those entries settle.
  while (transferLedgerEntries.length > TRANSFER_LEDGER_LIMIT) {
    let removeIndex = -1;
    for (let i = transferLedgerEntries.length - 1; i >= 0; i--) {
      if (!isLedgerEntryActive(transferLedgerEntries[i])) {
        removeIndex = i;
        break;
      }
    }
    if (removeIndex < 0) break;
    transferLedgerEntries.splice(removeIndex, 1);
  }
}

function getLedgerStatusLabel(status) {
  if (status === 'complete') return 'Complete';
  if (status === 'partial') return 'Partial';
  if (status === 'attention') return 'Attention';
  return 'Live';
}

function formatLedgerSource(source) {
  if (source === 'folder') return 'folder batch';
  if (source === 'incoming') return 'inbound';
  return 'file batch';
}

function getLedgerTimeLabel(entry) {
  const ts = Number(entry && entry.updatedAt) || Number(entry && entry.startedAt) || Date.now();
  return formatActivityTime(ts);
}

function trimLedgerTitles(transfers, max = 3) {
  const out = [];
  const list = Array.isArray(transfers) ? transfers : [];
  for (let i = 0; i < list.length; i++) {
    const title = String(list[i] && list[i].title || '').trim();
    if (!title || out.includes(title)) continue;
    out.push(title);
    if (out.length >= max) break;
  }
  return out;
}

function renderTransferLedger() {
  if (!transferLedgerListEl) return;

  const items = transferLedgerEntries.slice();
  transferLedgerListEl.textContent = '';

  let active = 0;
  let complete = 0;
  let attention = 0;

  if (items.length < 1) {
    const empty = document.createElement('div');
    empty.className = 'transfer-ledger-empty';
    empty.textContent = 'No transfer batches yet. Start a send or receive flow to populate the ledger.';
    transferLedgerListEl.appendChild(empty);
  }

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    const snap = computeLedgerEntrySnapshot(entry);
    if (snap.status === 'complete') complete++;
    else if (snap.status === 'live') active++;
    else attention++;

    const card = document.createElement('article');
    card.className = `ledger-entry ledger-entry-${snap.status}`;

    const head = document.createElement('div');
    head.className = 'ledger-entry-head';

    const dir = document.createElement('span');
    dir.className = `ledger-chip ledger-chip-${entry.direction === 'in' ? 'in' : 'out'}`;
    dir.textContent = entry.direction === 'in' ? 'Inbound' : 'Outbound';

    const source = document.createElement('span');
    source.className = 'ledger-chip';
    source.textContent = formatLedgerSource(entry.source);

    const count = document.createElement('span');
    count.className = 'ledger-chip';
    count.textContent = `${snap.payloadCount} payload${snap.payloadCount === 1 ? '' : 's'}`;

    const status = document.createElement('span');
    status.className = `ledger-status ledger-status-${snap.status}`;
    status.textContent = getLedgerStatusLabel(snap.status);

    head.appendChild(dir);
    head.appendChild(source);
    head.appendChild(count);
    head.appendChild(status);

    const title = document.createElement('h4');
    title.className = 'ledger-entry-title';
    title.textContent = String(entry.title || (entry.direction === 'in' ? 'Inbound transfer' : 'Outbound transfer batch'));

    const detail = document.createElement('p');
    detail.className = 'ledger-entry-detail';
    detail.textContent = String(entry.detail || '');

    const meta = document.createElement('div');
    meta.className = 'ledger-entry-meta';
    meta.innerHTML = [
      `<span>${formatBytes(snap.bytesDone)} / ${formatBytes(snap.totalBytes || snap.bytesDone)}</span>`,
      `<span>done ${snap.okCount}/${snap.payloadCount}</span>`,
      `<span>attention ${snap.attentionCount}</span>`,
      `<span>updated ${getLedgerTimeLabel(entry)}</span>`,
    ].join('');

    const progress = document.createElement('div');
    progress.className = 'ledger-progress';
    const fill = document.createElement('div');
    fill.className = 'ledger-progress-fill';
    fill.style.width = `${Math.max(0, Math.min(100, snap.progress))}%`;
    progress.appendChild(fill);

    const titles = trimLedgerTitles(entry.transfers);
    const strip = document.createElement('div');
    strip.className = 'ledger-title-strip';
    for (let j = 0; j < titles.length; j++) {
      const pill = document.createElement('span');
      pill.className = 'ledger-title-pill';
      pill.textContent = titles[j];
      strip.appendChild(pill);
    }
    if ((entry.transfers || []).length > titles.length) {
      const more = document.createElement('span');
      more.className = 'ledger-title-pill';
      more.textContent = `+${entry.transfers.length - titles.length} more`;
      strip.appendChild(more);
    }

    card.appendChild(head);
    card.appendChild(title);
    if (detail.textContent) card.appendChild(detail);
    card.appendChild(meta);
    card.appendChild(progress);
    if (strip.childNodes.length > 0) card.appendChild(strip);

    transferLedgerListEl.appendChild(card);
  }

  if (transferLedgerActiveCountEl) transferLedgerActiveCountEl.textContent = `active ${active}`;
  if (transferLedgerCompleteCountEl) transferLedgerCompleteCountEl.textContent = `complete ${complete}`;
  if (transferLedgerAttentionCountEl) transferLedgerAttentionCountEl.textContent = `attention ${attention}`;
}

function touchTransferLedgerEntry(entry, detail = null) {
  if (!entry || typeof entry !== 'object') return;
  entry.updatedAt = Date.now();
  if (typeof detail === 'string' && detail.trim()) entry.detail = detail.trim();
  pruneTransferLedger();
  renderTransferLedger();
}

function createTransferLedgerEntry({
  direction = 'out',
  source = 'files',
  count = 1,
  totalBytes = 0,
  title = '',
  detail = '',
} = {}) {
  transferLedgerSeq++;
  const entry = {
    id: transferLedgerSeq,
    direction: direction === 'in' ? 'in' : 'out',
    source,
    count: Math.max(1, Math.floor(Number(count) || 1)),
    totalBytes: Math.max(0, Number(totalBytes) || 0),
    title: String(title || '').trim() || 'Transfer batch',
    detail: String(detail || '').trim(),
    transfers: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  transferLedgerEntries.unshift(entry);
  pruneTransferLedger();

  renderTransferLedger();
  return entry;
}

function createTransferLedgerTransfer(entry, {
  title = '',
  totalBytes = 0,
  state = 'queued',
} = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const transfer = {
    entry,
    id: `${entry.id}:${entry.transfers.length + 1}`,
    title: String(title || '').trim() || 'payload',
    totalBytes: Math.max(0, Number(totalBytes) || 0),
    bytes: 0,
    state: String(state || 'queued'),
    sink: '',
    outcome: '',
    updatedAt: Date.now(),
  };
  entry.transfers.push(transfer);
  touchTransferLedgerEntry(entry);
  return transfer;
}

function updateTransferLedgerTransfer(transfer, patch = {}) {
  if (!transfer || typeof transfer !== 'object') return;
  if (typeof patch.title === 'string' && patch.title.trim()) transfer.title = patch.title.trim();
  if (Number.isFinite(patch.totalBytes) && patch.totalBytes >= 0) transfer.totalBytes = Math.floor(patch.totalBytes);
  if (Number.isFinite(patch.bytes) && patch.bytes >= 0) transfer.bytes = Math.floor(patch.bytes);
  if (typeof patch.state === 'string' && patch.state.trim()) transfer.state = patch.state.trim();
  if (typeof patch.sink === 'string') transfer.sink = patch.sink.trim();
  if (typeof patch.outcome === 'string') transfer.outcome = patch.outcome.trim();
  transfer.updatedAt = Date.now();
  touchTransferLedgerEntry(transfer.entry, typeof patch.detail === 'string' ? patch.detail : null);
}

function clearTransferLedger() {
  const kept = [];
  let removed = 0;
  for (let i = 0; i < transferLedgerEntries.length; i++) {
    const entry = transferLedgerEntries[i];
    if (isLedgerEntryActive(entry)) kept.push(entry);
    else removed++;
  }
  transferLedgerEntries.length = 0;
  if (kept.length > 0) transferLedgerEntries.push(...kept);
  renderTransferLedger();
  return {
    removed,
    activeKept: kept.length,
    totalAfter: transferLedgerEntries.length,
  };
}

function buildActivityExportText(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;
    const kind = mapActivityKind(entry.kind);
    const msg = normalizeActivityMessage(entry.msg);
    if (!msg) continue;
    lines.push(`[${formatActivityTime(entry.ts)}] [${kind}] ${msg}`);
  }
  return lines.join('\n');
}

function buildActivityFilterSnapshot() {
  return {
    query: getActivityQuery(),
    kinds: {
      conn: isActivityKindEnabled('conn'),
      transfer: isActivityKindEnabled('transfer'),
      receipt: isActivityKindEnabled('receipt'),
      warn: isActivityKindEnabled('warn'),
      status: isActivityKindEnabled('status'),
    },
  };
}

function buildActivityExportJson(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const list = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;
    const msg = normalizeActivityMessage(entry.msg);
    if (!msg) continue;
    list.push({
      id: Number.isFinite(entry.id) ? entry.id : null,
      timeLocal: formatActivityTime(entry.ts),
      timeIso: new Date(Number(entry.ts) || Date.now()).toISOString(),
      kind: mapActivityKind(entry.kind),
      message: msg,
    });
  }

  if (list.length < 1) return '';

  const payload = {
    exportedAt: new Date().toISOString(),
    filters: buildActivityFilterSnapshot(),
    visibleCount: list.length,
    entries: list,
  };
  return JSON.stringify(payload, null, 2);
}

function buildActivityFileBaseName() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `ephera-activity-${y}${mo}${da}-${h}${mi}${s}`;
}

function downloadTextFile(filename, text, mimeType = 'text/plain;charset=utf-8') {
  if (!text) return false;

  let url = null;
  let link = null;
  try {
    const blob = new Blob([text], { type: mimeType });
    url = URL.createObjectURL(blob);
    link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (link && link.parentNode) link.parentNode.removeChild(link);
    } catch {}
    if (url) {
      try {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch {}
    }
  }
}

function addActivity(kind, message) {
  const msg = normalizeActivityMessage(message);
  if (!msg) return;
  const normalizedKind = mapActivityKind(kind);
  activitySeq++;
  activityEntries.push({
    id: activitySeq,
    ts: Date.now(),
    kind: normalizedKind,
    msg,
  });

  if (activityEntries.length > ACTIVITY_LIMIT) {
    const overflow = activityEntries.length - ACTIVITY_LIMIT;
    activityEntries.splice(0, overflow);
  }

  renderActivityTimeline({ autoScroll: true });
}

function setStatus(text) {
  const value = typeof text === 'string' ? text : '';
  statusEl.textContent = value;
  const msg = normalizeActivityMessage(value);
  if (!msg) {
    lastStatusText = '';
  } else if (msg !== lastStatusText) {
    addActivity(inferActivityKindFromStatus(msg), msg);
    lastStatusText = msg;
  }
  renderStateStrip();
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

function sanitizePeerId(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  if (s.length < 8 || s.length > 64) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return '';
  return s;
}

function generateRoomJoinKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function shortPeerId(peerId) {
  const s = sanitizePeerId(peerId);
  if (!s) return 'unknown';
  if (s.length <= 8) return s;
  return s.slice(0, 8);
}

function isLocalRoomOwner() {
  return !!(localPeerId && roomOwnerPeerId && localPeerId === roomOwnerPeerId);
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
  const roomJoinKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
  if (!roomJoinKey) return '';

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

  const secret = new URLSearchParams();
  secret.set('roomJoinKey', roomJoinKey);

  if (includePassphrase) {
    const p = getLocalPassphrase();
    if (p) secret.set('passphrase', p);
  }

  const hashText = secret.toString();
  url.hash = hashText ? `#${hashText}` : '';

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
  renderLaunchpad();
}

function buildInvitePackageText() {
  const roomId = roomIdInput ? roomIdInput.value.trim() : '';
  const roomJoinKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
  const joinLink = joinLinkInput ? String(joinLinkInput.value || '').trim() : '';
  if (!roomId || !roomJoinKey || !joinLink) return '';

  const passphrase = getLocalPassphrase();
  const lines = [
    'Ephera Invite Package',
    `Room ID: ${roomId}`,
    `Room Auth Key: ${roomJoinKey}`,
    `Join Link: ${joinLink}`,
    `Passphrase: ${passphrase || '(not set - plain mode)'}`,
    'Note: verify passphrase out-of-band before transfer.',
  ];
  return lines.join('\n');
}

function setInvitePackageState(text, ok) {
  if (!invitePackageStateEl) return;
  invitePackageStateEl.textContent = text || '';
  invitePackageStateEl.classList.toggle('invite-package-state-ok', !!ok);
  invitePackageStateEl.classList.toggle('invite-package-state-warn', !ok);
}

function resetInvitePackageState() {
  if (!invitePackageStateEl) return;
  invitePackageStateEl.textContent = INVITE_PACKAGE_ACCEPT_TEXT;
  invitePackageStateEl.classList.remove('invite-package-state-ok', 'invite-package-state-warn');
}

function applyInvitePackage(rawText, { join = false } = {}) {
  const parsed = parseInvitePackageText(rawText);
  if (!parsed.ok) {
    setInvitePackageState(parsed.reason, false);
    setStatus(parsed.reason);
    if (E2E_STATE) E2E_STATE.invitePackageParseState = 'invalid';
    return false;
  }

  if (roomIdInput) roomIdInput.value = parsed.roomId;
  if (roomJoinKeyInput) roomJoinKeyInput.value = parsed.roomJoinKey;
  activeRoomJoinKey = parsed.roomJoinKey || null;

  if (passphraseInput && parsed.passphraseSeen) {
    passphraseInput.value = parsed.passphrase;
    onPassphraseChanged();
  } else {
    updateJoinLink();
    renderPeerState();
  }

  let appliedHint = 'Invite package applied.';
  if (parsed.source === 'link') appliedHint = 'Join link applied.';
  if (parsed.source === 'json') appliedHint = 'Invite JSON applied.';
  if (!parsed.passphraseSeen) {
    appliedHint += ' Passphrase not included; verify out-of-band.';
  }

  setInvitePackageState(appliedHint, true);
  if (E2E_STATE) {
    E2E_STATE.invitePackageAppliedCount = (E2E_STATE.invitePackageAppliedCount || 0) + 1;
    E2E_STATE.invitePackageParseState = 'ok';
  }

  if (join) {
    setStatus('Invite package applied. Joining room...');
    if (launchpadJoinBtn) launchpadJoinBtn.click();
    else if (joinRoomBtn) joinRoomBtn.click();
  } else {
    setStatus('Invite package applied');
  }

  return true;
}

function setQrPairingState(text, ok = null) {
  if (!qrPairingStateEl) return;
  qrPairingStateEl.textContent = text || 'QR pairing idle.';
  if (ok === true) {
    qrPairingStateEl.classList.add('qr-pairing-state-ok');
    qrPairingStateEl.classList.remove('qr-pairing-state-warn');
  } else if (ok === false) {
    qrPairingStateEl.classList.add('qr-pairing-state-warn');
    qrPairingStateEl.classList.remove('qr-pairing-state-ok');
  } else {
    qrPairingStateEl.classList.remove('qr-pairing-state-ok', 'qr-pairing-state-warn');
  }
}

function updateQrE2EState({ source = '', status = '', engine = '' } = {}) {
  if (!E2E_STATE) return;
  E2E_STATE.qrPayload = lastInviteQrPayload || '';
  E2E_STATE.qrVisible = !!(inviteQrCanvas && !inviteQrCanvas.hidden);
  if (engine) E2E_STATE.qrScanEngine = engine;
  if (source) E2E_STATE.qrLastScanSource = source;
  if (status) E2E_STATE.qrLastScanStatus = status;
}

function clearInviteQr() {
  lastInviteQrPayload = '';
  if (inviteQrCanvas) {
    try {
      const ctx = inviteQrCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, inviteQrCanvas.width, inviteQrCanvas.height);
    } catch {}
    inviteQrCanvas.hidden = true;
  }
  if (clearInviteQrBtn) clearInviteQrBtn.disabled = true;
  updateQrE2EState();
}

function resetQrPairingUi() {
  clearInviteQr();
  stopQrCamera({ silent: true });
  if (startQrCameraBtn) startQrCameraBtn.disabled = false;
  if (scanQrImageBtn) scanQrImageBtn.disabled = false;
  if (scanQrImageInput) scanQrImageInput.value = '';
  if (E2E_STATE) {
    E2E_STATE.qrLastScanSource = '';
    E2E_STATE.qrLastScanStatus = '';
    E2E_STATE.qrScanEngine = '';
  }
  if (QR_SCAN_SUPPORTED) {
    setQrPairingState('QR pairing idle.', null);
  } else {
    setQrPairingState('QR scan unavailable in this browser. Use paste/apply path.', false);
  }
}

function getInviteQrPayload() {
  const roomId = roomIdInput ? roomIdInput.value.trim() : '';
  const roomJoinKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
  const joinLink = joinLinkInput ? String(joinLinkInput.value || '').trim() : '';
  const passphrase = getLocalPassphrase() || '';
  return buildInviteQrPayload({
    roomId,
    roomJoinKey,
    joinLink,
    passphrase,
  });
}

function renderInviteQr(payload) {
  if (!(inviteQrCanvas instanceof HTMLCanvasElement)) return false;
  const text = typeof payload === 'string' ? payload.trim() : '';
  if (!text) return false;

  if (typeof window.qrcode !== 'function') {
    setQrPairingState('QR generator unavailable (local script missing).', false);
    return false;
  }

  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const quiet = 4;
    const modules = qr.getModuleCount();
    const cells = modules + (quiet * 2);
    const targetSize = 280;
    const scale = Math.max(2, Math.floor(targetSize / cells));
    const px = cells * scale;

    inviteQrCanvas.width = px;
    inviteQrCanvas.height = px;
    const ctx = inviteQrCanvas.getContext('2d');
    if (!ctx) {
      setQrPairingState('QR canvas unavailable.', false);
      return false;
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#111111';
    for (let y = 0; y < modules; y++) {
      for (let x = 0; x < modules; x++) {
        if (!qr.isDark(y, x)) continue;
        ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }

    inviteQrCanvas.hidden = false;
    lastInviteQrPayload = text;
    if (clearInviteQrBtn) clearInviteQrBtn.disabled = false;
    setQrPairingState('Invite QR ready. Scan with receiver device.', true);
    updateQrE2EState();
    return true;
  } catch {
    setQrPairingState('Failed to render QR (payload too large or invalid).', false);
    return false;
  }
}

let qrWorkCanvas = null;

function getSourceDimensions(source) {
  if (!source) return { width: 0, height: 0 };
  if (source instanceof HTMLVideoElement) {
    return {
      width: Math.max(0, Math.floor(source.videoWidth || 0)),
      height: Math.max(0, Math.floor(source.videoHeight || 0)),
    };
  }
  if (typeof source.width === 'number' && typeof source.height === 'number') {
    return {
      width: Math.max(0, Math.floor(source.width || 0)),
      height: Math.max(0, Math.floor(source.height || 0)),
    };
  }
  return { width: 0, height: 0 };
}

function getQrImageData(source) {
  const { width, height } = getSourceDimensions(source);
  if (!width || !height) return null;

  if (!(qrWorkCanvas instanceof HTMLCanvasElement)) {
    qrWorkCanvas = document.createElement('canvas');
  }
  qrWorkCanvas.width = width;
  qrWorkCanvas.height = height;

  const ctx = qrWorkCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

async function decodeQrWithBarcodeDetector(source) {
  if (!QR_DETECTOR_SUPPORTED || QR_SCAN_MODE === 'jsqr') return '';
  let detector = null;
  try {
    detector = new BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    try { detector = new BarcodeDetector(); } catch { return ''; }
  }

  try {
    const results = await detector.detect(source);
    if (!Array.isArray(results) || results.length < 1) return '';
    const raw = results[0] && typeof results[0].rawValue === 'string'
      ? results[0].rawValue.trim()
      : '';
    return raw;
  } catch {
    return '';
  }
}

function decodeQrWithJsQr(source) {
  if (!QR_JSQR_SUPPORTED || QR_SCAN_MODE === 'detector') return '';
  const imageData = getQrImageData(source);
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) return '';

  let out = null;
  try {
    out = window.jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
  } catch {
    return '';
  }
  if (!out || typeof out.data !== 'string') return '';
  return out.data.trim();
}

async function decodeQrFromSource(source) {
  if (!QR_SCAN_SUPPORTED) return { raw: '', engine: '' };

  if (QR_SCAN_MODE !== 'jsqr') {
    const raw = await decodeQrWithBarcodeDetector(source);
    if (raw) return { raw, engine: 'detector' };
    if (QR_SCAN_MODE === 'detector') return { raw: '', engine: 'detector' };
  }

  if (QR_SCAN_MODE !== 'detector') {
    const raw = decodeQrWithJsQr(source);
    if (raw) return { raw, engine: 'jsqr' };
    if (QR_SCAN_MODE === 'jsqr') return { raw: '', engine: 'jsqr' };
  }

  return { raw: '', engine: '' };
}

async function loadQrImageSourceFromFile(file) {
  if (!file) return null;

  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch {}
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try { URL.revokeObjectURL(url); } catch {}
      resolve(img);
    };
    img.onerror = () => {
      try { URL.revokeObjectURL(url); } catch {}
      reject(new Error('image load failed'));
    };
    img.src = url;
  });
}

function applyScannedQrRaw(rawValue, source, engine = '') {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) {
    setQrPairingState('QR scan yielded no payload.', false);
    updateQrE2EState({ source, status: 'empty', engine: engine || '' });
    return false;
  }

  if (invitePackageInput) invitePackageInput.value = raw;
  const ok = applyInvitePackage(raw, { join: true });
  if (!ok) {
    setQrPairingState('QR payload invalid. Verify room ID and auth key.', false);
    updateQrE2EState({ source, status: 'invalid', engine: engine || '' });
    return false;
  }

  setQrPairingState('QR payload applied. Joining room...', true);
  updateQrE2EState({ source, status: 'ok', engine: engine || '' });
  return true;
}

async function scanQrFromImageFile(file) {
  if (!file) {
    setQrPairingState('No image selected for QR scan.', false);
    updateQrE2EState({ source: 'image', status: 'empty' });
    return false;
  }
  if (!QR_SCAN_SUPPORTED) {
    setQrPairingState('QR image scan unavailable in this browser.', false);
    updateQrE2EState({ source: 'image', status: 'unsupported' });
    return false;
  }

  let source = null;
  try {
    source = await loadQrImageSourceFromFile(file);
    const decoded = await decodeQrFromSource(source);
    if (source && typeof source.close === 'function') source.close();
    return applyScannedQrRaw(decoded.raw, 'image', decoded.engine);
  } catch {
    if (source && typeof source.close === 'function') {
      try { source.close(); } catch {}
    }
    setQrPairingState('Failed to decode QR from image.', false);
    updateQrE2EState({ source: 'image', status: 'error' });
    return false;
  }
}

function stopQrCamera({ silent = false } = {}) {
  if (qrScanTimer) {
    clearInterval(qrScanTimer);
    qrScanTimer = null;
  }
  qrScanInFlight = false;

  if (qrCameraStream) {
    try {
      const tracks = qrCameraStream.getTracks();
      for (const t of tracks) {
        try { t.stop(); } catch {}
      }
    } catch {}
    qrCameraStream = null;
  }

  if (qrCameraPreview) {
    try { qrCameraPreview.pause(); } catch {}
    try { qrCameraPreview.srcObject = null; } catch {}
    qrCameraPreview.hidden = true;
  }

  if (stopQrCameraBtn) stopQrCameraBtn.disabled = true;
  if (startQrCameraBtn) startQrCameraBtn.disabled = false;

  if (!silent) setQrPairingState('QR camera stopped.', null);
  updateQrE2EState();
}

async function startQrCameraScan() {
  if (!QR_SCAN_SUPPORTED || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    setQrPairingState('Camera QR scan unavailable in this browser.', false);
    updateQrE2EState({ source: 'camera', status: 'unsupported' });
    return false;
  }
  if (!(qrCameraPreview instanceof HTMLVideoElement)) {
    setQrPairingState('Camera preview unavailable.', false);
    updateQrE2EState({ source: 'camera', status: 'error' });
    return false;
  }
  if (qrCameraStream) return true;

  try {
    qrCameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment' },
    });
  } catch {
    setQrPairingState('Camera permission denied or unavailable.', false);
    updateQrE2EState({ source: 'camera', status: 'denied' });
    return false;
  }

  try {
    qrCameraPreview.srcObject = qrCameraStream;
    qrCameraPreview.hidden = false;
    await qrCameraPreview.play();
  } catch {
    stopQrCamera({ silent: true });
    setQrPairingState('Failed to start camera preview.', false);
    updateQrE2EState({ source: 'camera', status: 'error' });
    return false;
  }

  if (startQrCameraBtn) startQrCameraBtn.disabled = true;
  if (stopQrCameraBtn) stopQrCameraBtn.disabled = false;
  setQrPairingState('Scanning QR from camera...', null);

  qrScanTimer = setInterval(async () => {
    if (!qrCameraPreview || qrCameraPreview.hidden || !qrCameraStream) return;
    if (qrScanInFlight) return;
    qrScanInFlight = true;
    try {
      const decoded = await decodeQrFromSource(qrCameraPreview);
      if (!decoded.raw) return;
      const ok = applyScannedQrRaw(decoded.raw, 'camera', decoded.engine);
      if (ok) stopQrCamera({ silent: true });
    } finally {
      qrScanInFlight = false;
    }
  }, 350);

  return true;
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
      localProtocolVersion: LOCAL_CAPABILITIES.protocolVersion,
      localMinProtocolVersion: LOCAL_CAPABILITIES.minSupported,
      peerProtocolVersion: peerCapabilities ? peerCapabilities.protocolVersion : null,
      peerMinProtocolVersion: peerCapabilities ? peerCapabilities.minSupported : null,
      capabilitiesCompatible: !!capabilitiesCompatible,
      compatibilityReason,
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

function getAdvertisedReadyValue() {
  return !!localReady && !!capabilitiesCompatible;
}

function sendReadySignal() {
  sendApp('ready', { value: getAdvertisedReadyValue(), cryptoMode: getLocalCryptoMode() });
}

function evaluateCapabilitiesCompatibilityState() {
  const result = evaluateCapabilityCompatibility(LOCAL_CAPABILITIES, peerCapabilities);
  capabilitiesCompatible = !!result.ok;
  compatibilityReason = result && typeof result.reason === 'string'
    ? result.reason
    : 'Protocol negotiation pending';

  if (E2E_STATE) {
    E2E_STATE.capabilitiesCompatible = capabilitiesCompatible;
    E2E_STATE.compatibilityReason = compatibilityReason;
    E2E_STATE.peerProtocolVersion = peerCapabilities ? peerCapabilities.protocolVersion : null;
  }

  return result;
}

function sendLocalCapabilities(reason = '') {
  try {
    sendApp('capabilities', LOCAL_CAPABILITIES);
    if (reason) {
      addActivity('conn', `Sent capabilities (${reason}) v${LOCAL_CAPABILITIES.protocolVersion}`);
    } else {
      addActivity('conn', `Sent capabilities v${LOCAL_CAPABILITIES.protocolVersion}`);
    }
  } catch {
    // Signaling may be down; caller handles reconnect path.
  }
}

function getSendGateState() {
  const localMode = getLocalCryptoMode();
  const modeOk = peerCryptoMode === localMode;
  const passOk = localMode !== 'passphrase' || passphraseVerified;
  const fileCount = Array.isArray(pendingOutboundEntries) ? pendingOutboundEntries.length : 0;

  if (!transportOpen) {
    return { enabled: false, reason: 'Waiting for P2P connection', localMode, modeOk, passOk, fileCount };
  }
  if (!peerCapabilities) {
    const pendingReason = compatibilityReason && compatibilityReason !== 'Protocol negotiation pending'
      ? compatibilityReason
      : 'Waiting for protocol negotiation';
    return { enabled: false, reason: pendingReason, localMode, modeOk, passOk, fileCount };
  }
  if (!capabilitiesCompatible) {
    return { enabled: false, reason: compatibilityReason || 'Protocol incompatible with peer', localMode, modeOk, passOk, fileCount };
  }
  if (!peerReady) {
    return { enabled: false, reason: 'Peer has not signaled ready', localMode, modeOk, passOk, fileCount };
  }
  if (!modeOk) {
    const reason = localMode === 'passphrase'
      ? 'Peer must set the same passphrase mode'
      : 'Set a passphrase to match peer secure mode';
    return { enabled: false, reason, localMode, modeOk, passOk, fileCount };
  }
  if (!passOk) {
    return { enabled: false, reason: 'Verifying passphrase match with peer', localMode, modeOk, passOk, fileCount };
  }
  if (fileCount < 1) {
    return { enabled: false, reason: 'Choose at least one payload', localMode, modeOk, passOk, fileCount };
  }

  return { enabled: true, reason: 'Ready to send', localMode, modeOk, passOk, fileCount };
}

function setSendGateReason(gate) {
  if (!sendGateReasonEl) return;
  const enabled = !!(gate && gate.enabled);
  const text = gate && gate.reason ? gate.reason : '';
  sendGateReasonEl.textContent = enabled ? 'Ready to send' : text;
  sendGateReasonEl.classList.toggle('send-gate-reason-ok', enabled);
  sendGateReasonEl.classList.toggle('send-gate-reason-warn', !enabled);
}

function setStateChip(el, text, ok) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('state-chip-ok', 'state-chip-warn');
  el.classList.add(ok ? 'state-chip-ok' : 'state-chip-warn');
}

function setPreflightPill(el, ok) {
  if (!el) return;
  el.textContent = ok ? 'PASS' : 'FAIL';
  el.classList.remove('preflight-pill-ok', 'preflight-pill-warn');
  el.classList.add(ok ? 'preflight-pill-ok' : 'preflight-pill-warn');
}

function detectSenderFolderUploadCapable() {
  if (FORCE_NO_FOLDER_UPLOAD) return false;
  if (!folderInput) return false;
  return (
    'webkitdirectory' in folderInput
    || 'directory' in folderInput
    || 'mozdirectory' in folderInput
  );
}

function getPreflightState() {
  const secureContext = !!window.isSecureContext;
  const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';
  const senderFolderUploadCapable = detectSenderFolderUploadCapable();
  const hasWebRTC = typeof RTCPeerConnection === 'function';
  const hasClipboard = !!(navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
  const folderSaveCapable = secureContext && hasDirectoryPicker;

  let summary = '';
  let fix = '';

  if (!hasWebRTC) {
    summary = 'Blocked: WebRTC unavailable';
    fix = 'WebRTC is required. Use a modern browser with WebRTC enabled.';
  } else if (!folderSaveCapable) {
    summary = 'Transfer ok (discard only)';
    if (!secureContext) {
      fix = 'Folder-save needs HTTPS secure context. Run `npm run dev:secure` or use HTTPS deployment.';
    } else {
      fix = 'Folder-save API unavailable in this browser. Use Chrome/Edge or keep using Ready (Discard).';
    }
  } else if (!hasClipboard) {
    summary = 'Core ok (clipboard limited)';
    fix = 'Clipboard API unavailable. Copy actions may require manual selection.';
  } else {
    summary = 'All core capabilities available';
    fix = 'No action needed.';
  }

  return {
    secureContext,
    hasDirectoryPicker,
    senderFolderUploadCapable,
    folderSaveCapable,
    hasWebRTC,
    hasClipboard,
    summary,
    fix,
    overallOk: hasWebRTC,
    folderSaveHint: folderSaveCapable
      ? ''
      : (!secureContext
        ? 'Folder-save requires HTTPS secure context'
        : 'Folder-save API unavailable in this browser'),
  };
}

function renderPreflight() {
  const pf = getPreflightState();

  setPreflightPill(preflightSecureStateEl, pf.secureContext);
  setPreflightPill(preflightFolderStateEl, pf.folderSaveCapable);
  setPreflightPill(preflightWebrtcStateEl, pf.hasWebRTC);
  setPreflightPill(preflightClipboardStateEl, pf.hasClipboard);

  if (preflightSummaryEl) {
    preflightSummaryEl.textContent = pf.summary;
    preflightSummaryEl.classList.remove('preflight-summary-ok', 'preflight-summary-warn');
    preflightSummaryEl.classList.add(pf.overallOk ? 'preflight-summary-ok' : 'preflight-summary-warn');
  }
  if (preflightFixEl) preflightFixEl.textContent = pf.fix;

  if (pickReceiveFolderBtn) {
    pickReceiveFolderBtn.disabled = !pf.folderSaveCapable;
    pickReceiveFolderBtn.title = pf.folderSaveCapable ? '' : (pf.folderSaveHint || 'Folder-save unavailable');
  }
  if (pickSendFolderBtn) {
    pickSendFolderBtn.disabled = !pf.senderFolderUploadCapable;
    pickSendFolderBtn.title = pf.senderFolderUploadCapable
      ? ''
      : 'Folder upload metadata is unavailable in this browser. Use Choose Files or drag-drop.';
  }

  if (E2E_STATE) {
    E2E_STATE.preflightSecureContext = pf.secureContext;
    E2E_STATE.preflightDirectoryPicker = pf.hasDirectoryPicker;
    E2E_STATE.preflightFolderSaveCapable = pf.folderSaveCapable;
    E2E_STATE.preflightSenderFolderUploadCapable = pf.senderFolderUploadCapable;
    E2E_STATE.preflightWebRTC = pf.hasWebRTC;
    E2E_STATE.preflightClipboard = pf.hasClipboard;
    E2E_STATE.preflightSummary = pf.summary;
    E2E_STATE.preflightFix = pf.fix;
    E2E_STATE.preflightOverall = pf.overallOk;
  }
}

function setFlowStepState(el, { done = false, active = false } = {}) {
  if (!el) return;
  el.classList.toggle('flow-step-done', !!done);
  el.classList.toggle('flow-step-active', !done && !!active);
}

function renderFlowGuide(gate) {
  const g = gate || getSendGateState();
  const stepEls = [
    flowStepRoomEl,
    flowStepP2PEl,
    flowStepLocalReadyEl,
    flowStepPeerReadyEl,
    flowStepSendEl,
  ];

  const stepDone = [
    !!activeRoomId,
    !!activeRoomId && !!transportOpen,
    !!activeRoomId && !!transportOpen && !!peerReady,
    !!activeRoomId
      && !!transportOpen
      && !!peerReady
      && !!peerCapabilities
      && !!capabilitiesCompatible
      && !!(g && g.modeOk)
      && !!(g && g.passOk),
    !!(g && g.enabled),
  ];

  let activeIndex = stepDone.findIndex((v) => !v);
  if (activeIndex < 0) activeIndex = stepDone.length - 1;
  const allDone = stepDone.every(Boolean);

  for (let i = 0; i < stepEls.length; i++) {
    setFlowStepState(stepEls[i], { done: stepDone[i], active: i === activeIndex });
  }

  const stepNames = [
    'Create or join a room',
    'Establish P2P channel',
    'Peer signals ready',
    'Protocol + crypto verified',
    'Choose payload and send',
  ];

  if (flowCurrentEl) {
    flowCurrentEl.textContent = allDone
      ? 'Step 5/5: Ready to send'
      : `Step ${activeIndex + 1}/5: ${stepNames[activeIndex]}`;
  }

  let nextText = 'Next: create or join a room.';
  if (!stepDone[0]) {
    nextText = 'Next: create or join a room.';
  } else if (!stepDone[1]) {
    nextText = 'Next: wait for P2P connection.';
  } else if (!stepDone[2]) {
    nextText = 'Next: wait for peer ready signal.';
  } else if (!stepDone[3]) {
    const reason = g && typeof g.reason === 'string' ? g.reason.trim() : '';
    nextText = reason ? `Next: ${reason}.` : 'Next: wait for protocol and crypto verification.';
  } else if (!stepDone[4]) {
    nextText = 'Next: choose payloads to enable Send.';
  } else {
    nextText = 'All transfer gates are green. Press Send.';
  }

  if (flowNextEl) flowNextEl.textContent = nextText;

  if (E2E_STATE) {
    E2E_STATE.flowStep = allDone ? 5 : (activeIndex + 1);
    E2E_STATE.flowReady = !!stepDone[4];
  }
}

function renderQuickSummary(gate) {
  const g = gate || getSendGateState();

  let text = 'Create or join a room to start.';
  if (activeRoomId && !transportOpen) {
    text = 'Waiting for P2P connection.';
  } else if (activeRoomId && transportOpen && !peerReady) {
    text = 'Waiting for peer ready signal.';
  } else if (activeRoomId && transportOpen && peerReady && (!peerCapabilities || !capabilitiesCompatible)) {
    text = compatibilityReason && compatibilityReason !== 'Protocol negotiation pending'
      ? compatibilityReason
      : 'Waiting for protocol negotiation.';
  } else if (activeRoomId && transportOpen && peerReady && g && !g.modeOk) {
    text = g.reason || 'Crypto mode mismatch.';
  } else if (activeRoomId && transportOpen && peerReady && g && !g.passOk) {
    text = g.reason || 'Verifying passphrase.';
  } else if (activeRoomId && transportOpen && peerReady && g && g.fileCount < 1) {
    text = 'Choose files or a folder to enable Send.';
  } else if (g && g.enabled) {
    text = 'Ready to send.';
  }

  if (transferQuickSummaryEl) {
    transferQuickSummaryEl.textContent = text;
    const ok = text === 'Ready to send.';
    transferQuickSummaryEl.classList.toggle('quick-summary-ok', ok);
    transferQuickSummaryEl.classList.toggle('quick-summary-warn', !ok);
  }

  if (E2E_STATE) {
    E2E_STATE.quickSummary = text;
    E2E_STATE.transferAdvancedOpen = !!(transferAdvancedDetailsEl && transferAdvancedDetailsEl.open);
  }
}

function setTransferProgressChip(el, { live = false, ready = false } = {}) {
  if (!el) return;
  el.classList.toggle('send-progress-chip-live', !!live);
  el.classList.toggle('send-progress-chip-ready', !!ready);
}

function renderTransferActionDeck(gate) {
  const g = gate || getSendGateState();
  const folderUploadCapable = detectSenderFolderUploadCapable();
  const receiveState = getReceiveDestinationState();
  const channelLive = !!(activeRoomId && transportOpen);
  const peerReadyLive = !!(channelLive && peerReady);
  const cryptoReady = !!(
    activeRoomId
    && transportOpen
    && peerReady
    && peerCapabilities
    && capabilitiesCompatible
    && g
    && g.modeOk
    && g.passOk
  );
  const senderReady = !!(g && g.enabled);

  let receiveBadge = 'Standby';
  let receiveCopy = 'Choose how this device should handle incoming payloads before the peer starts streaming.';
  let receiveTitle = 'Choose local receive policy';
  let receiveText = 'Pick a folder to save received files, or switch to discard mode to verify and drop payloads in memory.';

  if (receiveState.ready && receiveState.mode === 'saved') {
    receiveBadge = channelLive ? 'Ready' : 'Primed';
    receiveCopy = `This device will save inbound files to ${receiveState.folderName || 'selected folder'}.`;
    receiveTitle = channelLive ? 'Receiver is armed for folder save' : 'Local save destination is primed';
    receiveText = channelLive
      ? 'Peer can stream now. Incoming files will land in the selected folder on this device.'
      : 'The destination is already chosen. Once the direct channel opens, this tab can immediately advertise ready.';
  } else if (receiveState.ready && receiveState.mode === 'discard') {
    receiveBadge = channelLive ? 'Ready' : 'Primed';
    receiveCopy = 'This device is armed in discard mode for zero-retention receive verification.';
    receiveTitle = channelLive ? 'Receiver is armed in discard mode' : 'Discard mode is primed';
    receiveText = channelLive
      ? 'Peer can stream now. Ephera will verify payloads in memory and discard them after receipt.'
      : 'Local discard mode is set. When the direct channel opens, this tab can immediately advertise ready.';
  } else if (activeRoomId) {
    receiveBadge = 'Arm Local';
    receiveCopy = 'Set local receive posture now so the peer sees a clear readiness signal once transport opens.';
    receiveTitle = 'Choose folder save or discard';
    receiveText = 'Picking a receive mode is local-only. It does not expose your save path to the peer.';
  }

  if (receiveActionStateEl) receiveActionStateEl.textContent = receiveBadge;
  if (receiveActionCopyEl) receiveActionCopyEl.textContent = receiveCopy;
  if (receiveStageTitleEl) receiveStageTitleEl.textContent = receiveTitle;
  if (receiveStageTextEl) receiveStageTextEl.textContent = receiveText;

  if (receiveCardEl) {
    receiveCardEl.classList.toggle('transfer-action-live', !!activeRoomId);
    receiveCardEl.classList.toggle('transfer-action-ready', !!receiveState.ready);
    receiveCardEl.classList.toggle('transfer-action-locked', !receiveState.ready);
  }

  let sendBadge = 'Locked';
  let sendCopy = 'Sender controls stay visible, but the transport gate remains closed until the live session is fully negotiated.';
  let sendTitle = 'Waiting for live room';
  let sendText = 'Create or join a room first. Ephera only unlocks transfer after the direct channel and peer-ready signal are present.';

  if (activeRoomId && !transportOpen) {
    sendBadge = 'Await P2P';
    sendCopy = 'Room exists. The next unlock gate is the direct peer channel.';
    sendTitle = 'Waiting for direct channel';
    sendText = 'Share the join link or invite package. Sender controls will advance when the peer completes WebRTC negotiation.';
  } else if (channelLive && !peerReady) {
    sendBadge = 'Await Peer';
    sendCopy = 'Direct transport is established. Sender remains locked until the receiver chooses a ready mode.';
    sendTitle = 'Waiting for receiver readiness';
    sendText = 'Ask the peer to click Pick Receive Folder or Ready (Discard). That signal is the final operator-intent gate before send can arm.';
  } else if (channelLive && peerReady && !cryptoReady) {
    sendBadge = 'Verify';
    sendCopy = 'Transport is live. Ephera is still checking protocol compatibility and crypto alignment.';
    sendTitle = 'Negotiating protocol + crypto';
    sendText = g && g.reason ? g.reason : 'Waiting for capability exchange and passphrase verification to complete.';
  } else if (cryptoReady && !(g && g.fileCount > 0)) {
    sendBadge = 'Armed';
    sendCopy = 'All protocol gates are clear. Selecting payload files is the only remaining operator action.';
    sendTitle = folderUploadCapable ? 'Choose files or a folder' : 'Choose files';
    sendText = folderUploadCapable
      ? 'Multiple files or folder contents are streamed as concurrent transfers. File hierarchy is preserved when relative paths are provided.'
      : 'Multiple files are streamed as concurrent transfers. Folder batching is unavailable in this browser.';
  } else if (senderReady) {
    sendBadge = 'Unlocked';
    sendCopy = 'Session is fully live. Direct transfer is available now.';
    sendTitle = 'Ready for direct send';
    sendText = 'Press Send to stream payloads directly to the peer. No cloud retention or transfer history is introduced by Ephera.';
  }

  if (sendActionStateEl) sendActionStateEl.textContent = sendBadge;
  if (sendActionCopyEl) sendActionCopyEl.textContent = sendCopy;
  if (sendStageTitleEl) sendStageTitleEl.textContent = sendTitle;
  if (sendStageTextEl) sendStageTextEl.textContent = sendText;

  setTransferProgressChip(sendChipRoomEl, { live: !!activeRoomId, ready: !!activeRoomId });
  setTransferProgressChip(sendChipP2PEl, { live: !!activeRoomId, ready: channelLive });
  setTransferProgressChip(sendChipPeerEl, { live: channelLive, ready: peerReadyLive });
  setTransferProgressChip(sendChipCryptoEl, { live: peerReadyLive, ready: cryptoReady });

  if (sendCardEl) {
    sendCardEl.classList.toggle('transfer-action-live', !!activeRoomId);
    sendCardEl.classList.toggle('transfer-action-ready', senderReady);
    sendCardEl.classList.toggle('transfer-action-armed', cryptoReady && !!(g && g.fileCount < 1));
    sendCardEl.classList.toggle('transfer-action-locked', !cryptoReady);
  }

  renderSendDropzone(g);
}

function renderTransferBay(gate) {
  const g = gate || getSendGateState();
  const folderUploadCapable = detectSenderFolderUploadCapable();

  let state = 'Locked';
  let text = 'Create or join a room to unlock direct transfer controls.';
  let live = false;
  let ready = false;

  if (activeRoomId && !transportOpen) {
    state = 'Await P2P';
    text = 'Room is live. Open the join link on another tab or device and wait for the direct peer channel.';
    live = true;
  } else if (activeRoomId && transportOpen && !peerReady) {
    state = 'Await Peer';
    text = 'Direct channel is up. The receiver must choose Pick Receive Folder or Ready (Discard) to signal readiness.';
    live = true;
  } else if (activeRoomId && transportOpen && peerReady && (!peerCapabilities || !capabilitiesCompatible)) {
    state = 'Verifying';
    text = compatibilityReason && compatibilityReason !== 'Protocol negotiation pending'
      ? compatibilityReason
      : 'Channel is live. Waiting for protocol and crypto verification.';
    live = true;
  } else if (activeRoomId && transportOpen && peerReady && g && !g.modeOk) {
    state = 'Crypto Gate';
    text = g.reason || 'Crypto modes must match before sending.';
    live = true;
  } else if (activeRoomId && transportOpen && peerReady && g && !g.passOk) {
    state = 'Verifying';
    text = g.reason || 'Verifying passphrase before enabling send.';
    live = true;
  } else if (activeRoomId && transportOpen && peerReady && g && g.fileCount < 1) {
    state = 'Armed';
    text = folderUploadCapable
      ? 'Transfer bay is live. Choose files or a folder to enable Send.'
      : 'Transfer bay is live. Choose files to enable Send.';
    live = true;
  } else if (g && g.enabled) {
    state = 'Unlocked';
    text = 'Transfer bay is fully unlocked. Send files now; receiver save/discard mode is already negotiated.';
    live = true;
    ready = true;
  }

  if (transferLockStateEl) transferLockStateEl.textContent = state;
  if (transferLockTextEl) transferLockTextEl.textContent = text;

  if (transferLockBannerEl) {
    transferLockBannerEl.classList.toggle('transfer-lock-banner-live', live);
    transferLockBannerEl.classList.toggle('transfer-lock-banner-ready', ready);
  }

  if (transferSection) {
    transferSection.classList.toggle('transfer-shell-live', live);
    transferSection.classList.toggle('transfer-shell-ready', ready);
    transferSection.classList.toggle('transfer-shell-locked', !ready);
  }

  renderTransferActionDeck(g);

  if (fileInput) {
    fileInput.title = ready
      ? 'Choose one or more files to send'
      : 'Visible now for discoverability. Send unlocks after room, P2P, and peer-ready gates pass';
  }

  if (folderInput) {
    folderInput.title = !folderUploadCapable
      ? 'Folder upload metadata unavailable in this browser'
      : (ready
        ? 'Choose a folder to send with relative file hierarchy preserved'
        : 'Visible now for discoverability. Folder send unlocks after room, P2P, and peer-ready gates pass');
  }
}

function renderLaunchpad(gate) {
  const g = gate || getSendGateState();
  const signalingOpen = !!(ws && ws.readyState === WebSocket.OPEN);

  let state = 'Idle';
  let hint = 'Start by hosting a secure session or join an existing invite package.';
  let ok = false;

  if (activeRoomId && !transportOpen) {
    state = signalingOpen ? 'Room Live' : 'Reconnecting';
    hint = signalingOpen
      ? 'Share your invite package. Waiting for peer and P2P negotiation.'
      : 'Room context retained. Waiting for signaling reconnect.';
  } else if (activeRoomId && transportOpen && !peerReady) {
    state = 'Peer Needed';
    hint = 'P2P is up. Ask the peer to set receive mode and signal ready.';
  } else if (activeRoomId && transportOpen && peerReady && (!peerCapabilities || !capabilitiesCompatible)) {
    state = 'Verifying';
    hint = compatibilityReason && compatibilityReason !== 'Protocol negotiation pending'
      ? compatibilityReason
      : 'Protocol and crypto negotiation in progress.';
  } else if (g && g.enabled) {
    state = 'Go';
    hint = 'All transfer gates are green. Choose files and send.';
    ok = true;
  } else if (activeRoomId && transportOpen && peerReady) {
    state = 'Setup';
    hint = g && g.reason ? g.reason : 'Finish setup to enable sending.';
  }

  if (launchpadStateEl) {
    launchpadStateEl.textContent = state;
    launchpadStateEl.classList.toggle('launchpad-state-ok', !!ok);
    launchpadStateEl.classList.toggle('launchpad-state-warn', !ok);
  }
  if (launchpadHintEl) launchpadHintEl.textContent = hint;

  const inSession = !!(activeRoomId || transportOpen || signalingOpen);
  if (launchpadHostBtn) launchpadHostBtn.disabled = inSession || !!createRoomBtn.disabled;
  if (launchpadJoinBtn) launchpadJoinBtn.disabled = inSession || !!joinRoomBtn.disabled;
  if (applyInvitePackageBtn) applyInvitePackageBtn.disabled = inSession;
  if (applyJoinInvitePackageBtn) applyJoinInvitePackageBtn.disabled = inSession || !!joinRoomBtn.disabled;

  const inviteReady = !!buildInvitePackageText();
  if (copyInvitePackageBtn) copyInvitePackageBtn.disabled = !inviteReady;
  if (showInviteQrBtn) showInviteQrBtn.disabled = !inviteReady;
  if (scanQrImageBtn) scanQrImageBtn.disabled = inSession || !QR_SCAN_SUPPORTED;
  const cameraScanSupported = (
    QR_SCAN_SUPPORTED
    && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')
  );
  if (startQrCameraBtn) startQrCameraBtn.disabled = inSession || !cameraScanSupported || !!qrCameraStream;
  if (stopQrCameraBtn && !qrCameraStream) stopQrCameraBtn.disabled = true;

  if (E2E_STATE) {
    E2E_STATE.launchpadState = state;
    E2E_STATE.launchpadHint = hint;
    E2E_STATE.invitePackageReady = inviteReady;
  }
}

function getLocalOnboardingRole() {
  if (!activeRoomId) return 'none';
  if (isLocalRoomOwner()) return 'owner';
  if (localRoomRole === 'peer' || localRoomRole === 'owner') return 'peer';
  return 'pending';
}

function renderRoleOnboardingHint(gate) {
  const g = gate || getSendGateState();
  const role = getLocalOnboardingRole();

  let text = 'Role hint: create a room to become owner, or join as peer.';
  if (role === 'owner' && !transportOpen) {
    text = 'Owner hint: share the join link/key and wait for peer connection.';
  } else if (role === 'peer' && !transportOpen) {
    text = 'Peer hint: joined room, waiting for owner offer.';
  } else if (role === 'owner' && transportOpen && !peerReady) {
    text = 'Owner hint: ask peer to click Ready (Discard) or Pick Receive Folder.';
  } else if (role === 'peer' && transportOpen && !peerReady) {
    text = 'Peer hint: set your receive mode, then wait for owner send.';
  } else if ((role === 'owner' || role === 'peer') && transportOpen && peerReady && (!peerCapabilities || !capabilitiesCompatible)) {
    const base = role === 'owner'
      ? 'Owner hint: protocol/crypto gate must pass before sending.'
      : 'Peer hint: protocol/crypto verification in progress.';
    text = compatibilityReason && compatibilityReason !== 'Protocol negotiation pending'
      ? `${base} ${compatibilityReason}`
      : base;
  } else if (role === 'owner' && g && g.enabled) {
    text = 'Owner hint: ready to send. You can rotate key or close room.';
  } else if (role === 'peer' && g && g.enabled) {
    text = 'Peer hint: ready to send.';
  } else if (role === 'owner' && g && g.fileCount < 1) {
    text = 'Owner hint: choose files to send.';
  } else if (role === 'peer' && g && g.fileCount < 1) {
    text = 'Peer hint: choose files to send.';
  } else if (role === 'pending') {
    text = 'Role hint: waiting for room authority sync.';
  }

  if (roleOnboardingHintEl) {
    roleOnboardingHintEl.textContent = text;
    const ok = text.toLowerCase().includes('ready to send');
    roleOnboardingHintEl.classList.toggle('onboarding-hint-ok', ok);
    roleOnboardingHintEl.classList.toggle('onboarding-hint-warn', !ok);
  }

  if (E2E_STATE) {
    E2E_STATE.onboardingHint = text;
    E2E_STATE.onboardingRole = role;
  }
}

function renderRoomAuthority() {
  const inRoom = !!activeRoomId;
  const owner = isLocalRoomOwner();
  const role = inRoom
    ? (owner ? 'owner' : (localRoomRole === 'owner' || localRoomRole === 'peer' ? localRoomRole : 'pending'))
    : 'none';
  const ownerText = roomOwnerPeerId ? shortPeerId(roomOwnerPeerId) : (inRoom ? 'pending' : 'none');
  const localText = localPeerId ? shortPeerId(localPeerId) : (inRoom ? 'pending' : 'none');

  if (roomAuthorityEl) {
    roomAuthorityEl.textContent = `Authority: role=${role} | owner=${ownerText} | peer=${localText}`;
  }

  const canControl = !!(inRoom && owner && ws && ws.readyState === WebSocket.OPEN);
  if (rotateRoomKeyBtn) rotateRoomKeyBtn.disabled = !canControl;
  if (closeRoomBtn) closeRoomBtn.disabled = !canControl;

  if (stateOwnerEl) {
    if (!inRoom) {
      setStateChip(stateOwnerEl, 'role: none', false);
    } else if (owner) {
      setStateChip(stateOwnerEl, 'role: owner', true);
    } else if (role === 'peer') {
      setStateChip(stateOwnerEl, 'role: peer', true);
    } else {
      setStateChip(stateOwnerEl, 'role: pending', false);
    }
  }
}

function updateAuthorityStateForE2E() {
  if (!E2E_STATE) return;
  E2E_STATE.peerId = localPeerId || null;
  E2E_STATE.roomOwnerPeerId = roomOwnerPeerId || null;
  if (activeRoomId) {
    E2E_STATE.localRole = isLocalRoomOwner() ? 'owner' : (localRoomRole === 'owner' || localRoomRole === 'peer' ? localRoomRole : 'peer');
  } else {
    E2E_STATE.localRole = 'none';
  }
}

function applyRoomAuthorityFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;

  let changed = false;
  const t = typeof msg.type === 'string' ? msg.type : '';
  const canSetLocalPeerId = t === 'room-created' || t === 'room-joined';

  if (canSetLocalPeerId) {
    const nextPeerId = sanitizePeerId(msg.peerId);
    if (nextPeerId && nextPeerId !== localPeerId) {
      localPeerId = nextPeerId;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(msg, 'roomOwnerPeerId')) {
    const nextOwner = sanitizePeerId(msg.roomOwnerPeerId);
    const normalizedOwner = nextOwner || null;
    if (normalizedOwner !== roomOwnerPeerId) {
      roomOwnerPeerId = normalizedOwner;
      changed = true;
    }
  }

  if (canSetLocalPeerId && typeof msg.role === 'string') {
    const normalizedRole = msg.role === 'owner' ? 'owner' : (msg.role === 'peer' ? 'peer' : null);
    if (normalizedRole && normalizedRole !== localRoomRole) {
      localRoomRole = normalizedRole;
      changed = true;
    }
  }

  if (activeRoomId) {
    const inferredRole = isLocalRoomOwner() ? 'owner' : 'peer';
    if (inferredRole !== localRoomRole) {
      localRoomRole = inferredRole;
      changed = true;
    }
  }

  if (changed) {
    updateAuthorityStateForE2E();
    renderRoomAuthority();
  }
  return changed;
}

let dashboardRequested = defaultDashboardView;

function scrollViewportToTop() {
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    try { window.scrollTo(0, 0); } catch {}
  }
}

function renderShellView({ inRoom = false, channelLive = false, signalingOpen = false } = {}) {
  const dashboardVisible = !!(dashboardRequested || inRoom || channelLive || signalingOpen);
  const landingVisible = !dashboardVisible;
  const canReturnToLanding = !!(dashboardVisible && !inRoom && !channelLive && !signalingOpen);

  if (appRootEl) {
    appRootEl.classList.toggle('app-shell-landing', landingVisible);
    appRootEl.classList.toggle('app-shell-dashboard', dashboardVisible);
  }
  try {
    document.body.classList.toggle('body-shell-landing', landingVisible);
    document.body.classList.toggle('body-shell-dashboard', dashboardVisible);
  } catch {}
  if (landingShellEl) landingShellEl.hidden = !landingVisible;
  if (dashboardShellEl) dashboardShellEl.hidden = !dashboardVisible;

  for (let i = 0; i < returnLandingEls.length; i++) {
    returnLandingEls[i].hidden = !canReturnToLanding;
  }

  if (E2E_STATE) {
    E2E_STATE.shellView = dashboardVisible ? 'dashboard' : 'landing';
  }

  return dashboardVisible;
}

function requestDashboardView() {
  dashboardRequested = true;
  renderProductMode(getSendGateState());
  scrollViewportToTop();
}

function requestLandingView() {
  const signalingOpen = !!(ws && ws.readyState === WebSocket.OPEN);
  const inRoom = !!activeRoomId;
  const channelLive = !!(inRoom && transportOpen);
  if (inRoom || channelLive || signalingOpen) return;
  dashboardRequested = false;
  renderProductMode(getSendGateState());
  scrollViewportToTop();
}

function renderProductMode(gate) {
  const g = gate || getSendGateState();
  const signalingOpen = !!(ws && ws.readyState === WebSocket.OPEN);
  const inRoom = !!activeRoomId;
  const channelLive = !!(inRoom && transportOpen);
  const cockpitReady = !!(
    channelLive
    && peerReady
    && peerCapabilities
    && capabilitiesCompatible
    && g
    && g.modeOk
    && g.passOk
  );

  let mode = 'onboarding';
  let title = 'Operations Dashboard';
  let badge = 'Launch Sequence';
  let subtitle = 'Bring the room online, verify the direct path, and step into the transfer cockpit.';
  const showDashboard = renderShellView({ inRoom, channelLive, signalingOpen });
  let showLanding = !showDashboard;
  let showSide = !!showDashboard;
  let showTransfer = !!showDashboard;
  let showNav = !!showDashboard;
  let phaseState = 'Onboarding';
  let briefTitle = 'Establish the room boundary';
  let briefCopy = 'Start with the room boundary, bring in a peer, and hold the line until the direct path opens.';
  let nextTitle = 'Open or join a room';
  let nextCopy = 'Direct transfer stays gated until room, P2P, readiness, and crypto align.';
  let noteBoundary = 'No payload leaves the peer path.';
  let noteAction = 'Choose the host or join path to continue.';
  let noteUnlock = 'Transfer and telemetry stay visible, but transport remains locked until direct path exists.';
  let productSignalLabel = 'Boundary Offline';
  let productSignalMeta = 'Room offline · direct path closed';

  if (inRoom && !transportOpen) {
    mode = 'session';
    title = 'Room Control Live';
    badge = signalingOpen ? 'Awaiting Direct Channel' : 'Reconnecting Signaling';
    subtitle = signalingOpen
      ? 'The room boundary is live. Share the invite package or join link and wait for the direct peer channel.'
      : 'Room context is retained locally. Waiting for signaling recovery before peer-to-peer negotiation resumes.';
    showLanding = false;
    showSide = true;
    phaseState = signalingOpen ? 'Session Live' : 'Session Recovery';
    briefTitle = signalingOpen ? 'Room is online' : 'Restore signaling';
    briefCopy = signalingOpen
      ? 'The room boundary is active. The next event is peer arrival and direct channel negotiation.'
      : 'The room context is still local, but signaling is down. The cockpit stays gated until coordination returns.';
    nextTitle = signalingOpen ? 'Wait for peer connection' : 'Recover the signaling edge';
    nextCopy = signalingOpen
      ? 'Share the invite package or join link. Once the peer arrives, the app steps into direct-channel negotiation.'
      : 'Keep the room open. Once signaling reconnects, negotiation resumes without introducing storage.';
    noteAction = signalingOpen
      ? 'Distribute the invite package or join link.'
      : 'Hold the session; do not tear down unless you intend to rotate.';
    noteUnlock = 'Transfer bay remains visible, but WebRTC transport must open before send can unlock.';
    productSignalLabel = signalingOpen ? 'Room Boundary Live' : 'Room Recovery';
    productSignalMeta = signalingOpen ? 'Invite path open · direct channel pending' : 'Local room retained · signaling recovering';
  } else if (channelLive && !cockpitReady) {
    mode = 'channel';
    title = 'Transport Negotiation';
    badge = 'P2P Online';
    subtitle = 'The peer-to-peer channel is live. Finish receive readiness and crypto verification to fully arm the cockpit.';
    showLanding = false;
    showSide = true;
    showTransfer = true;
    showNav = true;
    phaseState = 'Negotiating';
    briefTitle = 'Direct transport is up';
    briefCopy = 'The session has crossed into direct peer transport. Ephera is now waiting on receiver readiness and crypto agreement.';
    nextTitle = 'Verify readiness + crypto';
    nextCopy = 'Receiver must choose save or discard mode, and both peers must agree on protocol and passphrase posture before the cockpit arms.';
    noteBoundary = 'Payload path is now direct WebRTC.';
    noteAction = 'Complete receive readiness and protocol verification.';
    noteUnlock = 'Dashboard modules remain visible; send stays gated until readiness and crypto checks pass.';
    productSignalLabel = 'Direct Channel Live';
    productSignalMeta = 'Peer path active · readiness and crypto verifying';
  } else if (cockpitReady) {
    mode = 'cockpit';
    title = 'Transfer Cockpit';
    badge = g && g.fileCount > 0 ? 'Ready To Send' : 'Channel Verified';
    subtitle = g && g.fileCount > 0
      ? 'Direct transport is online. Stage payloads, monitor the ledger, and operate without introducing retention.'
      : 'Direct transport is online and verified. Choose files or a folder to arm the send path.';
    showLanding = false;
    showSide = true;
    showTransfer = true;
    showNav = true;
    phaseState = g && g.fileCount > 0 ? 'Armed' : 'Verified';
    briefTitle = g && g.fileCount > 0 ? 'Cockpit is armed' : 'Channel is verified';
    briefCopy = g && g.fileCount > 0
      ? 'The direct path is unlocked. Payload staging is complete and the operator can stream immediately.'
      : 'All transport and crypto gates are green. The remaining action is to choose files or a folder.';
    nextTitle = g && g.fileCount > 0 ? 'Send the payload' : 'Choose payloads';
    nextCopy = g && g.fileCount > 0
      ? 'Use the transfer bay to stream now. Ledger and activity stay local without retention.'
      : 'The cockpit is live, but nothing is selected yet. Use the transfer bay to arm the send path.';
    noteBoundary = 'No relay or storage is in the payload path.';
    noteAction = g && g.fileCount > 0 ? 'Press Send when the payload selection is correct.' : 'Choose files or a folder to arm the cockpit.';
    noteUnlock = g && g.fileCount > 0 ? 'Send is already unlocked.' : 'Selecting payloads is the final operator gate.';
    productSignalLabel = g && g.fileCount > 0 ? 'Cockpit Armed' : 'Transfer Verified';
    productSignalMeta = g && g.fileCount > 0 ? 'Payload staged · direct stream ready to fire' : 'Direct path green · waiting for payload selection';
  }

  if (appRootEl) {
    appRootEl.classList.remove('app-mode-onboarding', 'app-mode-session', 'app-mode-channel', 'app-mode-cockpit');
    appRootEl.classList.add(`app-mode-${mode}`);
  }

  if (workspaceHeaderEl) {
    workspaceHeaderEl.classList.toggle('workspace-header-live', mode === 'cockpit');
    workspaceHeaderEl.classList.toggle('workspace-header-negotiation', mode === 'session' || mode === 'channel');
  }
  if (workspaceTitleEl) workspaceTitleEl.textContent = title;
  if (workspaceBadgeEl) workspaceBadgeEl.textContent = badge;
  if (workspaceSubtitleEl) workspaceSubtitleEl.textContent = subtitle;
  if (productSignalLabelEl) productSignalLabelEl.textContent = productSignalLabel;
  if (productSignalMetaEl) productSignalMetaEl.textContent = productSignalMeta;
  if (phaseStatePillEl) phaseStatePillEl.textContent = phaseState;
  if (phaseBriefTitleEl) phaseBriefTitleEl.textContent = briefTitle;
  if (phaseBriefCopyEl) phaseBriefCopyEl.textContent = briefCopy;
  if (phaseNextTitleEl) phaseNextTitleEl.textContent = nextTitle;
  if (phaseNextCopyEl) phaseNextCopyEl.textContent = nextCopy;
  if (phaseNoteBoundaryEl) phaseNoteBoundaryEl.textContent = noteBoundary;
  if (phaseNoteActionEl) phaseNoteActionEl.textContent = noteAction;
  if (phaseNoteUnlockEl) phaseNoteUnlockEl.textContent = noteUnlock;

  if (landingSectionEls && landingSectionEls.length > 0) {
    for (let i = 0; i < landingSectionEls.length; i++) {
      landingSectionEls[i].hidden = !showLanding;
    }
  }

  if (consoleNavEl) consoleNavEl.hidden = !showNav;
  if (workspaceSideColumnEl) workspaceSideColumnEl.hidden = !showSide;
  if (transferSection) transferSection.hidden = !showTransfer;
  if (workspaceSpotlightEl) {
    workspaceSpotlightEl.classList.toggle('workspace-spotlight-live', mode === 'cockpit');
    workspaceSpotlightEl.classList.toggle('workspace-spotlight-negotiation', mode === 'session' || mode === 'channel');
  }

  const phaseNodes = [
    [phaseNodeOnboardingEl, mode === 'onboarding', mode !== 'onboarding'],
    [phaseNodeSessionEl, mode === 'session', mode === 'channel' || mode === 'cockpit'],
    [phaseNodeChannelEl, mode === 'channel', mode === 'cockpit'],
    [phaseNodeCockpitEl, mode === 'cockpit', false],
  ];
  for (let i = 0; i < phaseNodes.length; i++) {
    const [node, active, complete] = phaseNodes[i];
    if (!node) continue;
    node.classList.toggle('phase-node-active', !!active);
    node.classList.toggle('phase-node-complete', !!complete);
  }

  if (E2E_STATE) {
    E2E_STATE.productMode = mode;
    E2E_STATE.workspaceTitle = title;
    E2E_STATE.workspaceBadge = badge;
  }
}

function resetRoomAuthority() {
  localPeerId = null;
  roomOwnerPeerId = null;
  localRoomRole = 'none';
  updateAuthorityStateForE2E();
  renderRoomAuthority();
}

function renderStateStrip(gate) {
  const g = gate || getSendGateState();
  const signalingOpen = !!(ws && ws.readyState === WebSocket.OPEN);
  const inRoom = !!activeRoomId;

  if (signalingOpen) {
    setStateChip(stateSignalingEl, 'signaling: connected', true);
  } else if (inRoom) {
    setStateChip(stateSignalingEl, 'signaling: reconnecting', false);
  } else {
    setStateChip(stateSignalingEl, 'signaling: offline', false);
  }

  setStateChip(stateP2PEl, transportOpen ? 'p2p: connected' : 'p2p: down', !!transportOpen);
  setStateChip(stateReadyEl, peerReady ? 'peer: ready' : 'peer: not ready', !!peerReady);

  const localMode = g && g.localMode ? g.localMode : getLocalCryptoMode();
  const modeMatch = localMode === peerCryptoMode;
  if (!modeMatch) {
    setStateChip(stateCryptoEl, 'crypto: mismatch', false);
  } else if (localMode === 'passphrase') {
    setStateChip(stateCryptoEl, passphraseVerified ? 'crypto: verified' : 'crypto: verifying', !!passphraseVerified);
  } else {
    setStateChip(stateCryptoEl, 'crypto: plain', true);
  }

  renderProductMode(g);
  renderRoomAuthority();
  renderFlowGuide(g);
  renderQuickSummary(g);
  renderTransferBay(g);
  renderLaunchpad(g);
  renderRoleOnboardingHint(g);
  renderPreflight();
  syncReceiveDestinationUI();
}

function updateSendButton() {
  const gate = getSendGateState();
  sendFileBtn.disabled = !gate.enabled;
  setSendGateReason(gate);
  renderStateStrip(gate);
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
  if (!peerCapabilities) {
    parts.push(compatibilityReason && compatibilityReason !== 'Protocol negotiation pending' ? 'proto=error' : 'proto=pending');
  } else if (capabilitiesCompatible) {
    parts.push(`proto=v${peerCapabilities.protocolVersion} ok`);
  } else {
    parts.push('proto=mismatch');
  }
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
  renderStateStrip();
}

function getReceiveFolderName() {
  if (!receiveDirHandle || typeof receiveDirHandle !== 'object') return '';
  const raw = typeof receiveDirHandle.name === 'string' ? receiveDirHandle.name.trim() : '';
  if (!raw) return 'selected-folder';
  return sanitizeFileName(raw) || raw || 'selected-folder';
}

function canPromptOpenReceiveFolder() {
  return !!(
    receiveDirHandle
    && typeof window.showDirectoryPicker === 'function'
    && window.isSecureContext
  );
}

function getReceiveDestinationState() {
  const folderName = getReceiveFolderName();
  const mode = folderName ? 'saved' : 'discard';
  const ready = !!localReady;

  if (mode === 'saved') {
    const shortLabel = ready ? `Save: ${folderName} (ready)` : `Save: ${folderName}`;
    const fullLabel = ready
      ? `save to folder "${folderName}" (ready)`
      : `save to folder "${folderName}" (not ready)`;
    const copyLabel = `Save destination: ${folderName}`;
    return { mode, ready, folderName, shortLabel, fullLabel, copyLabel };
  }

  return {
    mode: 'discard',
    ready,
    folderName: '',
    shortLabel: ready ? 'Discard mode (ready)' : 'Discard mode',
    fullLabel: ready ? 'discard mode (ready)' : 'discard mode (not ready)',
    copyLabel: 'Discard mode',
  };
}

function buildReceiveDestinationPath(fileName = '') {
  const state = getReceiveDestinationState();
  const safePath = sanitizeRelativeTransferPath(fileName);
  const safeFileName = safePath || (typeof fileName === 'string' ? fileName.trim() : '');
  if (state.mode === 'saved') {
    if (!safeFileName) return state.folderName || 'selected-folder';
    return `${state.folderName || 'selected-folder'}/${safeFileName}`;
  }
  if (!safeFileName) return 'discard mode';
  return `discarded (${safeFileName})`;
}

function syncReceiveDestinationUI() {
  const state = getReceiveDestinationState();

  if (receiveFolderLabel) {
    receiveFolderLabel.textContent = state.shortLabel;
  }

  if (receiveDestinationStateEl) {
    receiveDestinationStateEl.textContent = `Destination: ${state.fullLabel}`;
    receiveDestinationStateEl.classList.toggle('receive-destination-ready', state.mode === 'saved');
    receiveDestinationStateEl.classList.toggle('receive-destination-discard', state.mode === 'discard');
  }

  if (copyReceiveDestinationBtn) {
    copyReceiveDestinationBtn.disabled = false;
  }

  const canOpen = canPromptOpenReceiveFolder();
  if (openReceiveFolderBtn) {
    openReceiveFolderBtn.disabled = !canOpen;
    openReceiveFolderBtn.title = canOpen
      ? 'Opens the folder picker at current receive destination when supported'
      : 'Open folder is unavailable in this browser/session';
  }

  renderTransferActionDeck();

  if (E2E_STATE) {
    E2E_STATE.receiveDestinationMode = state.mode;
    E2E_STATE.receiveDestinationLabel = state.fullLabel;
    E2E_STATE.receiveDestinationPath = state.mode === 'saved' ? (state.folderName || 'selected-folder') : 'discard mode';
    E2E_STATE.canOpenReceiveFolder = canOpen;
  }
}

function getReceiveDestinationCopyText(fileName = '') {
  const state = getReceiveDestinationState();
  const safePath = sanitizeRelativeTransferPath(fileName);
  const safeFileName = safePath || (typeof fileName === 'string' ? fileName.trim() : '');
  if (safeFileName) {
    if (state.mode === 'saved') return `Saved destination: ${buildReceiveDestinationPath(safeFileName)}`;
    return `Discarded transfer: ${safeFileName}`;
  }
  return state.copyLabel;
}

async function openReceiveFolderAtCurrentDestination() {
  if (!canPromptOpenReceiveFolder()) return false;
  try {
    const options = { mode: 'readwrite' };
    if (receiveDirHandle) options.startIn = receiveDirHandle;
    await window.showDirectoryPicker(options);
    return true;
  } catch {
    return false;
  }
}

async function existsInDirectory(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function getUniqueReceiveFileHandle(dirHandle, proposedName, transferHexId) {
  let fileName = sanitizeFileName(proposedName) || `ephera-${transferHexId}.bin`;
  if (await existsInDirectory(dirHandle, fileName)) {
    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    const short = String(transferHexId || '').slice(0, 8) || 'transfer';

    let candidate = sanitizeFileName(`${base} (${short})${ext}`) || `ephera-${short}.bin`;
    if (await existsInDirectory(dirHandle, candidate)) {
      for (let i = 2; i <= 50; i++) {
        // eslint-disable-next-line no-await-in-loop
        const next = sanitizeFileName(`${base} (${short}-${i})${ext}`) || `ephera-${short}-${i}.bin`;
        // eslint-disable-next-line no-await-in-loop
        if (!(await existsInDirectory(dirHandle, next))) {
          candidate = next;
          break;
        }
      }
    }
    fileName = candidate;
  }

  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  return { fileHandle, fileName };
}

async function resolveReceiveWriteTarget(rootDirHandle, transferHexId, { relativePath = '', fallbackName = '' } = {}) {
  const safeRelativePath = sanitizeRelativeTransferPath(relativePath);
  const fallbackSafeName = sanitizeFileName(fallbackName) || `ephera-${transferHexId}.bin`;

  let dirHandle = rootDirHandle;
  let parentPath = '';
  let targetName = fallbackSafeName;

  if (safeRelativePath && typeof rootDirHandle.getDirectoryHandle === 'function') {
    const parts = safeRelativePath.split('/');
    const maybeName = parts.pop();
    if (maybeName) targetName = maybeName;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      // eslint-disable-next-line no-await-in-loop
      dirHandle = await dirHandle.getDirectoryHandle(seg, { create: true });
    }
    parentPath = parts.join('/');
  } else if (safeRelativePath) {
    const baseName = getTransferPathBasename(safeRelativePath);
    if (baseName) targetName = baseName;
  }

  const { fileHandle, fileName } = await getUniqueReceiveFileHandle(dirHandle, targetName, transferHexId);
  const savedRelativePath = parentPath ? `${parentPath}/${fileName}` : fileName;
  return { fileHandle, fileName, savedRelativePath };
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

  const outcome = document.createElement('div');
  outcome.className = 'transfer-outcome';
  outcome.hidden = true;
  row.appendChild(outcome);

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
    setOutcome: (text, { ok = false, warn = false } = {}) => {
      const t = typeof text === 'string' ? text.trim() : '';
      outcome.classList.remove('transfer-outcome-ok', 'transfer-outcome-warn');
      if (!t) {
        outcome.textContent = '';
        outcome.hidden = true;
        return;
      }
      outcome.textContent = t;
      outcome.hidden = false;
      if (warn) {
        outcome.classList.add('transfer-outcome-warn');
      } else if (ok) {
        outcome.classList.add('transfer-outcome-ok');
      }
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

function sanitizeRelativeTransferPath(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;

  s = s.replace(/\\/g, '/');
  s = s.replace(/^\/+/, '');
  s = s.replace(/\/+/g, '/');
  if (!s) return null;

  const rawSegments = s.split('/').filter(Boolean);
  if (rawSegments.length < 1 || rawSegments.length > 24) return null;

  const safeSegments = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (!seg || seg === '.' || seg === '..') return null;
    const safe = sanitizeFileName(seg);
    if (!safe) return null;
    safeSegments.push(safe);
  }

  const out = safeSegments.join('/');
  if (!out || out.length > 768) return null;
  return out;
}

function getTransferPathBasename(value) {
  const safe = sanitizeRelativeTransferPath(value);
  if (!safe) return null;
  const parts = safe.split('/');
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function getOutboundEntryDisplayName(entry) {
  if (!entry || typeof entry !== 'object') return 'unnamed';
  const safePath = sanitizeRelativeTransferPath(entry.relativePath);
  if (safePath) return safePath;
  const safeName = sanitizeFileName(entry.name || (entry.file && entry.file.name) || '');
  return safeName || 'unnamed';
}

function getOutboundBatchRoot(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++) {
    const safePath = sanitizeRelativeTransferPath(list[i] && list[i].relativePath);
    if (!safePath) continue;
    const parts = safePath.split('/');
    if (parts.length > 1) return parts[0];
  }
  return '';
}

function buildOutboundBatchTitle(entries, source) {
  const list = Array.isArray(entries) ? entries : [];
  const count = list.length;
  if (source === 'folder') {
    const root = getOutboundBatchRoot(list) || 'folder';
    if (count <= 1) return `Folder send · ${getOutboundEntryDisplayName(list[0])}`;
    return `Folder batch · ${root}`;
  }
  if (count <= 1) return `Direct send · ${getOutboundEntryDisplayName(list[0])}`;
  return `File batch · ${count} payloads`;
}

function buildOutboundEntriesFromInput(fileList, { preferRelativePath = false } = {}) {
  const files = Array.from(fileList || []);
  const entries = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const relativePath = preferRelativePath
      ? sanitizeRelativeTransferPath(file.webkitRelativePath || '')
      : null;
    const name = sanitizeFileName(file.name || '') || 'unnamed';
    entries.push({
      file,
      name,
      relativePath,
    });
  }

  return entries;
}

function clearOutboundPickerValues() {
  if (fileInput) {
    try { fileInput.value = ''; } catch {}
  }
  if (folderInput) {
    try { folderInput.value = ''; } catch {}
  }
}

function inferOutboundSource(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (sanitizeRelativeTransferPath(entry && entry.relativePath)) return 'folder';
  }
  return list.length > 0 ? 'files' : 'none';
}

function renderSendDropzone(gate) {
  if (!sendDropzoneEl) return;

  const g = gate || getSendGateState();
  const folderUploadCapable = detectSenderFolderUploadCapable();
  const count = Array.isArray(pendingOutboundEntries) ? pendingOutboundEntries.length : 0;
  const staged = count > 0;
  const source = inferOutboundSource(pendingOutboundEntries);
  const dragging = sendDropzoneDragDepth > 0;
  const ready = !!(g && g.enabled);
  const live = !!activeRoomId;

  let title = folderUploadCapable ? 'Drop files or folders here' : 'Drop files here';
  let hint = folderUploadCapable
    ? 'Stage payloads directly in the transfer bay. You can drop before the room fully unlocks; Send still stays gated until the session is ready.'
    : 'Stage files directly in the transfer bay. Send still stays gated until the session is ready.';

  if (dragging) {
    title = 'Release to stage payloads';
    hint = folderUploadCapable
      ? 'Ephera will import dropped files immediately. File hierarchy is preserved when the browser exposes directory structure.'
      : 'Ephera will import dropped files immediately.';
  } else if (staged && source === 'folder') {
    title = `${count} folder payload${count === 1 ? '' : 's'} staged`;
    hint = ready
      ? 'Hierarchy-preserving payloads are armed. Press Send to stream them directly to the peer.'
      : 'Hierarchy-preserving payloads are staged. Send will unlock when room, P2P, peer-ready, and crypto gates are clear.';
  } else if (staged) {
    title = `${count} file payload${count === 1 ? '' : 's'} staged`;
    hint = ready
      ? 'Payloads are armed. Press Send to stream them directly to the peer.'
      : 'Payloads are staged. Send will unlock when room, P2P, peer-ready, and crypto gates are clear.';
  } else if (ready) {
    title = folderUploadCapable ? 'Drop files or folders here' : 'Drop files here';
    hint = folderUploadCapable
      ? 'Session is live. Drop payloads directly into the bay or use the pickers below, then press Send.'
      : 'Session is live. Drop files into the bay or use Choose Files, then press Send.';
  } else if (live && transportOpen && !peerReady) {
    title = 'Stage payloads while peer arms receive mode';
    hint = 'You can queue files now. Send stays blocked until the receiver chooses folder-save or discard mode.';
  } else if (live) {
    title = 'Stage payloads while the session negotiates';
    hint = folderUploadCapable
      ? 'You can stage files or folders early. Ephera will still enforce P2P, peer-ready, and crypto verification before send.'
      : 'You can stage files early. Ephera will still enforce P2P, peer-ready, and crypto verification before send.';
  }

  if (sendDropzoneTitleEl) sendDropzoneTitleEl.textContent = title;
  if (sendDropzoneHintEl) sendDropzoneHintEl.textContent = hint;

  sendDropzoneEl.classList.toggle('send-dropzone-live', live);
  sendDropzoneEl.classList.toggle('send-dropzone-ready', ready);
  sendDropzoneEl.classList.toggle('send-dropzone-staged', staged);
  sendDropzoneEl.classList.toggle('send-dropzone-drag', dragging);
  sendDropzoneEl.title = hint;
}

function syncOutboundSelectionSummary() {
  if (!sendSelectionSummaryEl) return;
  const count = Array.isArray(pendingOutboundEntries) ? pendingOutboundEntries.length : 0;

  if (count < 1) {
    sendSelectionSummaryEl.textContent = 'No payload selected.';
  } else if (pendingOutboundSource === 'folder') {
    const first = pendingOutboundEntries[0];
    const safePath = sanitizeRelativeTransferPath(first && first.relativePath);
    const root = safePath ? safePath.split('/')[0] : 'folder';
    sendSelectionSummaryEl.textContent = `Folder batch selected: ${count} file(s) from ${root}.`;
  } else if (count === 1) {
    sendSelectionSummaryEl.textContent = `Payload selected: ${getOutboundEntryDisplayName(pendingOutboundEntries[0])}.`;
  } else {
    sendSelectionSummaryEl.textContent = `Payload batch selected: ${count} file(s).`;
  }
}

function setPendingOutboundEntries(entries, source = 'none') {
  pendingOutboundEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (pendingOutboundEntries.length < 1) {
    pendingOutboundSource = 'none';
  } else {
    // Source is derived from captured metadata; callers cannot force
    // "folder" mode when no relative paths were actually provided.
    const inferred = inferOutboundSource(pendingOutboundEntries);
    pendingOutboundSource = inferred === 'none' ? source : inferred;
  }
  syncOutboundSelectionSummary();
  renderSendDropzone();
}

function readWebkitEntryFile(entry) {
  return new Promise((resolve, reject) => {
    try {
      entry.file(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

function readAllWebkitDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const out = [];
    const pump = () => {
      try {
        reader.readEntries((batch) => {
          if (!Array.isArray(batch) || batch.length < 1) {
            resolve(out);
            return;
          }
          out.push(...batch);
          pump();
        }, reject);
      } catch (err) {
        reject(err);
      }
    };
    pump();
  });
}

async function collectOutboundEntriesFromWebkitEntry(entry, parentPath = '') {
  if (!entry) return [];

  if (entry.isFile) {
    const file = await readWebkitEntryFile(entry);
    const name = sanitizeFileName((file && file.name) || entry.name || '') || 'unnamed';
    return [{
      file,
      name,
      relativePath: parentPath ? sanitizeRelativeTransferPath(`${parentPath}/${name}`) : null,
    }];
  }

  if (!entry.isDirectory || typeof entry.createReader !== 'function') return [];

  const dirName = sanitizeFileName(entry.name || '');
  if (!dirName) return [];

  const nextParent = parentPath ? `${parentPath}/${dirName}` : dirName;
  const reader = entry.createReader();
  const children = await readAllWebkitDirectoryEntries(reader);
  const out = [];

  for (let i = 0; i < children.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const nested = await collectOutboundEntriesFromWebkitEntry(children[i], nextParent);
    if (nested.length > 0) out.push(...nested);
  }

  return out;
}

async function collectOutboundEntriesFromHandle(handle, parentPath = '') {
  if (!handle || typeof handle !== 'object') return [];

  if (handle.kind === 'file' && typeof handle.getFile === 'function') {
    const file = await handle.getFile();
    const name = sanitizeFileName((file && file.name) || handle.name || '') || 'unnamed';
    return [{
      file,
      name,
      relativePath: parentPath ? sanitizeRelativeTransferPath(`${parentPath}/${name}`) : null,
    }];
  }

  if (handle.kind !== 'directory' || typeof handle.values !== 'function') return [];

  const dirName = sanitizeFileName(handle.name || '');
  if (!dirName) return [];

  const nextParent = parentPath ? `${parentPath}/${dirName}` : dirName;
  const out = [];

  // FileSystemDirectoryHandle is async-iterable in Chromium.
  // eslint-disable-next-line no-restricted-syntax
  for await (const child of handle.values()) {
    // eslint-disable-next-line no-await-in-loop
    const nested = await collectOutboundEntriesFromHandle(child, nextParent);
    if (nested.length > 0) out.push(...nested);
  }

  return out;
}

async function buildOutboundEntriesFromDataTransfer(dataTransfer) {
  const items = dataTransfer ? Array.from(dataTransfer.items || []) : [];
  const files = dataTransfer ? Array.from(dataTransfer.files || []) : [];
  const fileItems = items.filter((item) => item && item.kind === 'file');

  if (fileItems.length > 0) {
    if (typeof fileItems[0].getAsFileSystemHandle === 'function') {
      const out = [];
      for (let i = 0; i < fileItems.length; i++) {
        let handle = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          handle = await fileItems[i].getAsFileSystemHandle();
        } catch {}
        if (!handle) continue;
        // eslint-disable-next-line no-await-in-loop
        const nested = await collectOutboundEntriesFromHandle(handle);
        if (nested.length > 0) out.push(...nested);
      }
      if (out.length > 0) return out;
    }

    if (typeof fileItems[0].webkitGetAsEntry === 'function') {
      const out = [];
      for (let i = 0; i < fileItems.length; i++) {
        let entry = null;
        try { entry = fileItems[i].webkitGetAsEntry(); } catch {}
        if (!entry) continue;
        // eslint-disable-next-line no-await-in-loop
        const nested = await collectOutboundEntriesFromWebkitEntry(entry);
        if (nested.length > 0) out.push(...nested);
      }
      if (out.length > 0) return out;
    }
  }

  return buildOutboundEntriesFromInput(files, { preferRelativePath: false });
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
  const short = hexId(transferId).slice(0, 8);
  addActivity('receipt', `Sent receipt ${receipt.status}/${receipt.sink} (${formatBytes(b)}) for ${short}`);
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
  addActivity('conn', `Signaling reconnect scheduled (attempt ${attempt + 1}) in ${delay}ms`);

  signalingReconnectTimer = setTimeout(() => {
    signalingReconnectTimer = null;
    attemptSignalingReconnect().then((ok) => {
      if (ok) {
        signalingReconnectAttempts = 0;
        return;
      }
      addActivity('warn', 'Signaling reconnect attempt failed; retrying');
      signalingReconnectAttempts = Math.min(30, Math.max(0, Math.floor(signalingReconnectAttempts)) + 1);
      scheduleSignalingReconnect();
    }).catch(() => {
      addActivity('warn', 'Signaling reconnect attempt errored; retrying');
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
  addActivity('conn', 'Attempting signaling reconnect');

  try {
    const roomId = activeRoomId;
    const roomJoinKey = sanitizeRoomJoinKey(
      activeRoomJoinKey || (roomJoinKeyInput ? roomJoinKeyInput.value : '')
    );
    if (!roomJoinKey) {
      addActivity('warn', 'Signaling reconnect blocked: missing room auth key');
      return false;
    }
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
          socket.send(JSON.stringify({ type: 'join-room', roomId, roomJoinKey }));
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
          if (typeof msg.roomJoinKey === 'string') {
            activeRoomJoinKey = sanitizeRoomJoinKey(msg.roomJoinKey) || roomJoinKey;
            if (roomJoinKeyInput && activeRoomJoinKey) roomJoinKeyInput.value = activeRoomJoinKey;
            updateJoinLink();
          }
          applyRoomAuthorityFromMessage(msg);
          ws = socket;
          if (E2E_STATE) {
            E2E_STATE.signalingConnected = true;
            E2E_STATE.signalingReconnects = (E2E_STATE.signalingReconnects || 0) + 1;
          }

          // Re-announce readiness state after reconnect so the peer UI remains correct.
          try {
            sendLocalCapabilities('signaling reconnected');
            sendReadySignal();
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
          addActivity('conn', 'Signaling reconnect succeeded');
          resolve(true);
          return;
        }

        if (msg.type === 'peer-joined' && initiator) {
          applyRoomAuthorityFromMessage(msg);
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
          applyRoomAuthorityFromMessage(msg);
          if (transportOpen) {
            setStatus('Peer left signaling (P2P active)');
            return;
          }
          cleanup();
          return;
        }

        if (msg.type === 'room-key-rotated') {
          if (typeof msg.roomJoinKey === 'string') {
            const nextJoinKey = sanitizeRoomJoinKey(msg.roomJoinKey);
            if (nextJoinKey) {
              activeRoomJoinKey = nextJoinKey;
              if (roomJoinKeyInput) roomJoinKeyInput.value = nextJoinKey;
              updateJoinLink();
            }
          }
          applyRoomAuthorityFromMessage(msg);
          if (E2E_STATE) E2E_STATE.roomKeyRotatedCount = (E2E_STATE.roomKeyRotatedCount || 0) + 1;
          const rotatedBy = sanitizePeerId(msg.rotatedByPeerId);
          if (rotatedBy && localPeerId && rotatedBy === localPeerId) {
            setStatus('Room auth key rotated');
          } else {
            setStatus('Room auth key rotated by owner');
          }
          return;
        }

        if (msg.type === 'room-owner-changed') {
          applyRoomAuthorityFromMessage(msg);
          if (E2E_STATE) E2E_STATE.roomOwnerChangedCount = (E2E_STATE.roomOwnerChangedCount || 0) + 1;
          setStatus(isLocalRoomOwner() ? 'You are now room owner' : 'Room owner changed');
          return;
        }

        if (msg.type === 'room-closed') {
          if (E2E_STATE) E2E_STATE.roomClosedCount = (E2E_STATE.roomClosedCount || 0) + 1;
          cleanup();
          setStatus('Room closed by owner');
          return;
        }

        if (msg.type === 'error') {
          const message = typeof msg.message === 'string' ? msg.message : 'Signaling error';
          const joinUnavailable = (
            message === 'Join unavailable'
            || message === 'Room not found'
            || message === 'Room full'
          );

          // During reconnect, join can fail if signaling restarted or if the room has
          // reached peer capacity. For initiators, attempt recreate once as a repair path.
          if (!settled) {
            if (joinUnavailable && initiator && !triedCreate) {
              triedCreate = true;
              addActivity('conn', 'Reconnect join unavailable; attempting room recreate');
              try {
                socket.send(JSON.stringify({ type: 'create-room', roomId, roomJoinKey }));
                return;
              } catch {}
            }

            if (joinUnavailable) {
              addActivity('warn', 'Signaling reconnect join unavailable');
              try { socket.close(); } catch {}
              resolve(false);
              return;
            }

            if (initiator && message === 'Room already exists') {
              // Race: if the peer recreated the room, try join.
              try {
                socket.send(JSON.stringify({ type: 'join-room', roomId, roomJoinKey }));
                return;
              } catch {}
            }
          }

          setStatus(message);
        }
      };

      socket.onerror = () => {
        // onclose will follow; keep logic deterministic.
        addActivity('warn', 'Signaling reconnect socket error');
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
        if (!settled) {
          addActivity('warn', 'Signaling reconnect closed before success');
          resolve(false);
        }
      };
    });

    return ok;
  } finally {
    signalingReconnectInFlight = false;
  }
}

function connectSignaling(roomId, initiator, roomJoinKey) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(SIGNALING_URL);
    ws = socket;
    isInitiator = !!initiator;
    let settled = false;
    const normalizedRoomJoinKey = sanitizeRoomJoinKey(roomJoinKey);

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: initiator ? 'create-room' : 'join-room',
        roomId,
        roomJoinKey: normalizedRoomJoinKey,
      }));
    };

    socket.onmessage = async (e) => {
      if (ws !== socket) return;

      const msg = JSON.parse(e.data);

      if (msg.type === 'room-created' || msg.type === 'room-joined') {
        settled = true;
        activeRoomId = roomId;
        activeRoomJoinKey = sanitizeRoomJoinKey(msg.roomJoinKey) || normalizedRoomJoinKey;
        if (roomJoinKeyInput && activeRoomJoinKey) roomJoinKeyInput.value = activeRoomJoinKey;
        applyRoomAuthorityFromMessage(msg);
        updateJoinLink();
        signalingReconnectAttempts = 0;
        if (E2E_STATE) E2E_STATE.signalingConnected = true;
        sendLocalCapabilities('signaling connected');
        resolve();
        return;
      }

      if (msg.type === 'peer-joined' && initiator) {
        applyRoomAuthorityFromMessage(msg);
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
        applyRoomAuthorityFromMessage(msg);
        if (transportOpen) {
          // Signaling presence is not authoritative once P2P is established.
          // Transport close is the source of truth.
          setStatus('Peer left signaling (P2P active)');
          return;
        }

        cleanup();
        return;
      }

      if (msg.type === 'room-key-rotated') {
        if (typeof msg.roomJoinKey === 'string') {
          const nextJoinKey = sanitizeRoomJoinKey(msg.roomJoinKey);
          if (nextJoinKey) {
            activeRoomJoinKey = nextJoinKey;
            if (roomJoinKeyInput) roomJoinKeyInput.value = nextJoinKey;
            updateJoinLink();
          }
        }
        applyRoomAuthorityFromMessage(msg);
        if (E2E_STATE) E2E_STATE.roomKeyRotatedCount = (E2E_STATE.roomKeyRotatedCount || 0) + 1;
        const rotatedBy = sanitizePeerId(msg.rotatedByPeerId);
        if (rotatedBy && localPeerId && rotatedBy === localPeerId) {
          setStatus('Room auth key rotated');
        } else {
          setStatus('Room auth key rotated by owner');
        }
        return;
      }

      if (msg.type === 'room-owner-changed') {
        applyRoomAuthorityFromMessage(msg);
        if (E2E_STATE) E2E_STATE.roomOwnerChangedCount = (E2E_STATE.roomOwnerChangedCount || 0) + 1;
        setStatus(isLocalRoomOwner() ? 'You are now room owner' : 'Room owner changed');
        return;
      }

      if (msg.type === 'room-closed') {
        if (E2E_STATE) E2E_STATE.roomClosedCount = (E2E_STATE.roomClosedCount || 0) + 1;
        cleanup();
        setStatus('Room closed by owner');
        return;
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
    if (entry.ledgerTransfer) {
      updateTransferLedgerTransfer(entry.ledgerTransfer, {
        state: 'receiver-aborted',
        detail: `Peer aborted ${entry.ledgerTransfer.title || key.slice(0, 8)}`,
      });
    }
    addActivity('warn', `Outbound ${key.slice(0, 8)} aborted by peer`);

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
    if (entry.ledgerTransfer) {
      updateTransferLedgerTransfer(entry.ledgerTransfer, {
        state: sink === 'saved' ? 'delivered-saved' : 'delivered-discarded',
        sink,
        detail: sink === 'saved' ? 'Delivered and saved by peer' : 'Delivered and discarded by peer',
      });
    }
    addActivity('receipt', `Receipt ok (${sink}) for ${key.slice(0, 8)}`);
    entry.delivered = true;
    if (IS_E2E && E2E_STATE) {
      E2E_STATE.deliveredCount = (E2E_STATE.deliveredCount || 0) + 1;
      if (sink === 'saved') E2E_STATE.deliveredSavedCount = (E2E_STATE.deliveredSavedCount || 0) + 1;
      if (sink === 'discarded') E2E_STATE.deliveredDiscardCount = (E2E_STATE.deliveredDiscardCount || 0) + 1;
    }
  } else {
    try { if (entry.row) entry.row.setStatus('receiver aborted'); } catch {}
    if (entry.ledgerTransfer) {
      updateTransferLedgerTransfer(entry.ledgerTransfer, {
        state: 'receipt-abort',
        detail: `Receiver aborted ${entry.ledgerTransfer.title || key.slice(0, 8)}`,
      });
    }
    addActivity('receipt', `Receipt abort for ${key.slice(0, 8)}`);
  }

  outboundTransfers.delete(key);
}

function createTransport() {
  transport = new EpheraTransport({
    sendCandidate: (candidate) => sendSignal({ candidate }),
  }, getIceServers() || undefined, getRtcConfig() || undefined);

  transport.onOpen = () => {
    transportOpen = true;
    if (transferSection) transferSection.hidden = false;
    setStatus('P2P connected');
    sendLocalCapabilities('transport open');
    if (localReady) {
      try { sendReadySignal(); } catch {}
    }
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

  if (app.type === 'capabilities') {
    const incoming = sanitizeCapabilities(app.payload);
    if (!incoming) {
      peerCapabilities = null;
      capabilitiesCompatible = false;
      compatibilityReason = 'Invalid peer capabilities payload';
      if (E2E_STATE) {
        E2E_STATE.capabilitiesCompatible = false;
        E2E_STATE.compatibilityReason = compatibilityReason;
        E2E_STATE.peerProtocolVersion = null;
      }
      addActivity('warn', compatibilityReason);
      setStatus(compatibilityReason);
      renderPeerState();
      updateSendButton();
      if (localReady) {
        try { sendReadySignal(); } catch {}
      }
      return;
    }

    peerCapabilities = incoming;
    const result = evaluateCapabilitiesCompatibilityState();

    if (result.ok) {
      addActivity('conn', `Protocol compatible (negotiated v${result.negotiatedVersion})`);
    } else {
      addActivity('warn', compatibilityReason);
      setStatus(compatibilityReason);
    }

    renderPeerState();
    updateSendButton();
    if (localReady) {
      try { sendReadySignal(); } catch {}
    }
    return;
  }

  if (app.type === 'ready') {
    peerReady = !!(app.payload && app.payload.value);
    peerCryptoMode = (app.payload && app.payload.cryptoMode === 'passphrase')
      ? 'passphrase'
      : 'none';
    addActivity('conn', `Peer readiness update: ${peerReady ? 'ready' : 'not ready'} (crypto=${peerCryptoMode})`);

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
  if (state !== lastIceState) {
    addActivity('conn', `ICE state: ${state}`);
    lastIceState = state;
  }
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
    addActivity('warn', `ICE restart deferred (${reason}): signaling unavailable`);
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
    addActivity('conn', `ICE restart triggered (${reason})`);
    setStatus(`Reconnecting (${reason})`);
  } catch (err) {
    restartInFlight = false;
    if (E2E_STATE) E2E_STATE.restartInFlight = false;
    addActivity('warn', `ICE restart failed (${reason})`);
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

async function startOutboundTransfer(entry, { weight, passphrase, markE2E = false, ledgerTransfer = null } = {}) {
  const file = entry && entry.file ? entry.file : entry;
  if (!file || !transport) return false;

  const relativePath = sanitizeRelativeTransferPath(entry && entry.relativePath);
  const displayName = getOutboundEntryDisplayName(entry && entry.file ? entry : { file });
  const totalBytes = Number(file.size) || 0;

  sendAdvisoryMeaning(file);
  addActivity('transfer', `Outbound start: ${displayName} (${formatBytes(file.size || 0)})`);
  if (ledgerTransfer) {
    updateTransferLedgerTransfer(ledgerTransfer, {
      title: displayName,
      totalBytes: totalBytes || 0,
      state: 'sending',
      detail: `Streaming ${displayName}`,
    });
  }
  let sentBytes = 0;
  let lastPct = null;
  let lastSpeedTs = (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
  let lastSpeedBytes = 0;
  let cancelled = false;

  const row = addTransferRow({
    direction: 'out',
    title: displayName,
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
      if (ledgerTransfer) {
        updateTransferLedgerTransfer(ledgerTransfer, {
          bytes: sentBytes,
          state: cancelled ? 'cancelling' : 'sending',
        });
      }

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
      path: relativePath || null,
    },
  });
  activeSenders.add(localSender);

  row.setStatus('sending');
  row.setCancel(() => {
    cancelled = true;
    row.setStatus('cancelling');
    addActivity('warn', `Outbound cancel requested: ${displayName}`);
    if (ledgerTransfer) {
      updateTransferLedgerTransfer(ledgerTransfer, {
        state: 'cancelling',
        detail: `Cancelling ${displayName}`,
      });
    }
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
      ledgerTransfer,
    });
    addActivity('transfer', `Outbound transfer id=${transferKey.slice(0, 8)} weight=${Math.max(1, Number(weight) || 1)}`);
  }

  try {
    await startPromise;

    row.setBytes(totalBytes || sentBytes);
    if (totalBytes > 0) row.setProgress(100);
    row.setSpeed('');

    if (cancelled) {
      row.setStatus('cancelled');
      addActivity('warn', `Outbound cancelled: ${displayName}`);
      if (ledgerTransfer) {
        updateTransferLedgerTransfer(ledgerTransfer, {
          bytes: totalBytes || sentBytes,
          state: 'cancelled',
          detail: `Cancelled ${displayName}`,
        });
      }
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
            if (cur.ledgerTransfer) {
              updateTransferLedgerTransfer(cur.ledgerTransfer, {
                state: 'receipt-timeout',
                detail: `Receipt timeout for ${cur.ledgerTransfer.title || transferKey.slice(0, 8)}`,
              });
            }
            addActivity('warn', `Receipt timeout for ${transferKey.slice(0, 8)}`);
          }
          outboundTransfers.delete(transferKey);
        }, RECEIPT_TIMEOUT_MS);
      }
    }

    row.setStatus(awaitingReceipt ? 'sent (awaiting receipt)' : 'sent');
    if (ledgerTransfer) {
      updateTransferLedgerTransfer(ledgerTransfer, {
        bytes: totalBytes || sentBytes,
        state: awaitingReceipt ? 'awaiting-receipt' : 'sent',
        detail: awaitingReceipt
          ? `Awaiting receiver receipt for ${displayName}`
          : `Sent ${displayName}`,
      });
    }
    addActivity('transfer', awaitingReceipt
      ? `Outbound sent: ${displayName} (awaiting receipt)`
      : `Outbound sent: ${displayName}`);
    if (IS_E2E && E2E_STATE) E2E_STATE.sentDoneCount = (E2E_STATE.sentDoneCount || 0) + 1;
    if (markE2E && E2E_STATE) E2E_STATE.sentDone = true;
    return true;
  } catch (err) {
    if (cancelled) {
      row.setStatus('cancelled');
      addActivity('warn', `Outbound cancelled: ${displayName}`);
      if (ledgerTransfer) {
        updateTransferLedgerTransfer(ledgerTransfer, {
          bytes: totalBytes || sentBytes,
          state: 'cancelled',
          detail: `Cancelled ${displayName}`,
        });
      }
      return false;
    }

    row.setStatus('aborted');
    addActivity('warn', `Outbound aborted: ${displayName} (${err && err.message ? err.message : 'send failed'})`);
    if (ledgerTransfer) {
      updateTransferLedgerTransfer(ledgerTransfer, {
        bytes: totalBytes || sentBytes,
        state: 'aborted',
        detail: `Aborted ${displayName}`,
        outcome: err && err.message ? err.message : 'send failed',
      });
    }
    if (IS_E2E && E2E_STATE) E2E_STATE.sentAbortCount = (E2E_STATE.sentAbortCount || 0) + 1;
    if (IS_E2E && E2E_STATE && !E2E_STATE.error) {
      const detail = err && err.message ? err.message : 'send failed';
      const name = displayName || 'unknown';
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

  const all = Array.isArray(pendingOutboundEntries) ? pendingOutboundEntries.slice() : [];
  if (all.length === 0) return;

  const gate = getSendGateState();
  if (!gate.enabled) {
    setStatus(gate.reason || 'Send blocked');
    return;
  }

  const files = all;
  setStatus(`Sending ${files.length} transfer(s)`);

  const weight = Number(sendWeightInput?.value || 1) || 1;
  const passphrase = getLocalPassphrase();
  const source = inferOutboundSource(files);
  const totalBytes = files.reduce((sum, current) => {
    const file = current && current.file ? current.file : null;
    return sum + Math.max(0, Number(file && file.size) || 0);
  }, 0);
  const batchRoot = source === 'folder' ? getOutboundBatchRoot(files) : '';
  const ledgerEntry = createTransferLedgerEntry({
    direction: 'out',
    source,
    count: files.length,
    totalBytes,
    title: buildOutboundBatchTitle(files, source),
    detail: source === 'folder'
      ? `Streaming folder payloads${batchRoot ? ` from ${batchRoot}` : ''}`
      : `Streaming ${files.length} file payload${files.length === 1 ? '' : 's'}`,
  });

  setPendingOutboundEntries([], 'none');
  clearOutboundPickerValues();
  updateSendButton();

  // Start transfers on a new task so the click handler returns immediately,
  // even when many files are queued.
  const tasks = files.map((entry, i) => new Promise((resolve) => {
    const displayName = getOutboundEntryDisplayName(entry);
    const transfer = createTransferLedgerTransfer(ledgerEntry, {
      title: displayName,
      totalBytes: Number(entry && entry.file && entry.file.size) || 0,
      state: 'queued',
    });
    setTimeout(() => {
      startOutboundTransfer(entry, {
        weight,
        passphrase,
        markE2E: IS_E2E && i === 0,
        ledgerTransfer: transfer,
      })
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
  const ledgerEntry = createTransferLedgerEntry({
    direction: 'in',
    source: 'incoming',
    count: 1,
    totalBytes: 0,
    title: `Inbound transfer · ${id.slice(0, 8)}`,
    detail: 'Waiting for metadata and destination policy',
  });
  const ledgerTransfer = createTransferLedgerTransfer(ledgerEntry, {
    title: id,
    totalBytes: 0,
    state: 'receiving',
  });
  row.setStatus('receiving');
  row.setOutcome(`destination: ${buildReceiveDestinationPath()}`, {
    warn: getReceiveDestinationState().mode === 'discard',
    ok: getReceiveDestinationState().mode === 'saved',
  });
  addActivity('transfer', `Inbound start: ${id.slice(0, 8)}`);

  if (!capabilitiesCompatible) {
    const reason = compatibilityReason || 'Protocol incompatible with peer';
    row.setStatus('aborted (protocol incompatible)');
    updateTransferLedgerTransfer(ledgerTransfer, {
      state: 'blocked',
      detail: `Blocked ${id.slice(0, 8)}: ${reason}`,
      outcome: reason,
    });
    addActivity('warn', `Inbound blocked for ${id.slice(0, 8)}: ${reason}`);
    setStatus(reason);
    sendPeerAbort(session.transferId);
    return;
  }

  const stream = session.getStream();
  if (!stream) {
    row.setStatus('aborted');
    updateTransferLedgerTransfer(ledgerTransfer, {
      state: 'aborted',
      detail: `Inbound stream unavailable for ${id.slice(0, 8)}`,
      outcome: 'stream unavailable',
    });
    addActivity('warn', `Inbound aborted before stream open: ${id.slice(0, 8)}`);
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
    addActivity('warn', `Sent abort for inbound ${id.slice(0, 8)}`);
  };

  const DEFAULT_NAME = `ephera-${id}.bin`;
  let saveName = DEFAULT_NAME;
  let saveRelativePath = '';
  let outputName = saveName;
  let outputRelativePath = '';

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

    const safePath = sanitizeRelativeTransferPath(obj.path);
    const safeName = sanitizeFileName(obj.name);
    const displayName = safePath || safeName;
    if (displayName) {
      row.setTitle(displayName);
      ledgerEntry.title = `Inbound transfer · ${displayName}`;
      updateTransferLedgerTransfer(ledgerTransfer, {
        title: displayName,
        detail: `Receiving ${displayName}`,
      });
      if (E2E_STATE) E2E_STATE.recvTitle = displayName;
      if (IS_E2E && E2E_STATE && Array.isArray(E2E_STATE.recvTitles)) {
        E2E_STATE.recvTitles.push(displayName);
      }
    }

    if (safePath && !writable) {
      saveRelativePath = safePath;
      const baseName = getTransferPathBasename(safePath);
      if (baseName) saveName = baseName;
    }

    if (safeName) {
      // Only use the suggested name if we haven't opened the output file yet.
      if (!writable) saveName = safeName;
    }

    if (Number.isFinite(obj.size) && obj.size >= 0) {
      expectedBytes = Math.floor(obj.size);
      updateTransferLedgerTransfer(ledgerTransfer, {
        totalBytes: expectedBytes,
      });
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
    addActivity('warn', `Inbound cancel requested: ${id.slice(0, 8)}`);
    updateTransferLedgerTransfer(ledgerTransfer, {
      state: 'cancelling',
      detail: `Cancelling ${ledgerTransfer.title || id.slice(0, 8)}`,
    });
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

    outputName = saveName || DEFAULT_NAME;
    outputRelativePath = saveRelativePath || outputName;

    if (receiveDirHandle && typeof receiveDirHandle.getFileHandle === 'function') {
      const target = await resolveReceiveWriteTarget(receiveDirHandle, id, {
        relativePath: saveRelativePath,
        fallbackName: saveName || DEFAULT_NAME,
      });
      outputName = target.fileName;
      outputRelativePath = target.savedRelativePath || target.fileName;
      const fileHandle = target.fileHandle;
      writable = await fileHandle.createWritable();
      row.setTitle(outputRelativePath);
      row.setStatus(aesKey ? `decrypting + saving: ${outputRelativePath}` : `saving: ${outputRelativePath}`);
      row.setOutcome(`destination: ${buildReceiveDestinationPath(outputRelativePath)}`, { ok: true });
      updateTransferLedgerTransfer(ledgerTransfer, {
        title: outputRelativePath,
        state: 'receiving',
        detail: `Saving into ${buildReceiveDestinationPath(outputRelativePath)}`,
      });
    } else {
      discard = true;
      row.setTitle(outputRelativePath || outputName);
      row.setStatus(aesKey ? `decrypting + discarding: ${outputRelativePath}` : `discarding: ${outputRelativePath}`);
      row.setOutcome(`destination: ${buildReceiveDestinationPath(outputRelativePath || outputName)}`, { warn: true });
      updateTransferLedgerTransfer(ledgerTransfer, {
        title: outputRelativePath || outputName,
        state: 'receiving',
        detail: `Discarding ${outputRelativePath || outputName} after verification`,
      });
    }

    const modeLabel = discard
      ? (aesKey ? 'decrypting + discarding (no receive folder)' : 'discarding (no receive folder)')
      : (aesKey ? `decrypting + saving: ${outputRelativePath}` : `saving: ${outputRelativePath}`);

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
      updateTransferLedgerTransfer(ledgerTransfer, {
        bytes,
        state: 'receiving',
      });
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
      row.setOutcome('inbound cancelled before completion', { warn: true });
      addActivity('warn', `Inbound cancelled: ${id.slice(0, 8)}`);
      updateTransferLedgerTransfer(ledgerTransfer, {
        bytes,
        state: 'cancelled',
        detail: `Cancelled ${ledgerTransfer.title || id.slice(0, 8)}`,
      });
      return;
    }

    const finalLabel = outputRelativePath || outputName;
    const outcomeText = discard
      ? `discarded -> ${finalLabel}`
      : `saved -> ${buildReceiveDestinationPath(finalLabel)}`;

    if (aesKey) {
      row.setStatus(discard ? 'received (decrypted, discarded)' : 'received (decrypted, saved)');
    } else {
      row.setStatus(discard ? 'received (discarded)' : 'received (saved)');
    }
    updateTransferLedgerTransfer(ledgerTransfer, {
      bytes,
      state: discard ? 'received-discarded' : 'received-saved',
      sink: discard ? 'discarded' : 'saved',
      detail: outcomeText,
      outcome: outcomeText,
    });
    row.setOutcome(outcomeText, { ok: !discard, warn: discard });
    addActivity('transfer', `Inbound complete: ${finalLabel} (${formatBytes(bytes)}) [${outcomeText}]`);
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
    if (E2E_STATE) E2E_STATE.lastInboundOutcome = outcomeText;
  } catch (err) {
    row.setStatus(cancelled ? 'cancelled' : 'aborted');
    row.setOutcome(cancelled ? 'inbound cancelled' : 'inbound aborted', { warn: true });
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
    if (E2E_STATE && !cancelled) E2E_STATE.lastInboundOutcome = 'inbound aborted';
    updateTransferLedgerTransfer(ledgerTransfer, {
      bytes,
      state: cancelled ? 'cancelled' : 'aborted',
      detail: cancelled
        ? `Cancelled ${ledgerTransfer.title || id.slice(0, 8)}`
        : `Aborted ${ledgerTransfer.title || id.slice(0, 8)}`,
      outcome: err && err.message ? err.message : 'receive failed',
    });
    addActivity('warn', `Inbound ${cancelled ? 'cancelled' : 'aborted'}: ${id.slice(0, 8)} (${err && err.message ? err.message : 'receive failed'})`);
  } finally {
    try { reader.releaseLock(); } catch {}
    row.setCancel(null);
  }
}

/* ---------- Cleanup ---------- */

function cleanup() {
  addActivity('conn', 'Session cleanup');
  transportOpen = false;
  peerReady = false;
  peerCapabilities = null;
  capabilitiesCompatible = false;
  compatibilityReason = 'Protocol negotiation pending';
  peerCryptoMode = 'none';
  resetPassphraseVerification();
  peerMeaning = null;
  localReady = false;
  isInitiator = false;
  activeRoomId = null;
  activeRoomJoinKey = null;
  resetRoomAuthority();
  clearSignalingReconnect();
  if (E2E_STATE) E2E_STATE.signalingConnected = false;
  if (E2E_STATE) E2E_STATE.transportOpen = false;
  if (E2E_STATE) E2E_STATE.peerReady = false;
  if (E2E_STATE) E2E_STATE.capabilitiesCompatible = false;
  if (E2E_STATE) E2E_STATE.compatibilityReason = compatibilityReason;
  if (E2E_STATE) E2E_STATE.peerProtocolVersion = null;
  if (E2E_STATE) E2E_STATE.iceConnectionState = null;
  lastIceState = null;
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

  if (transferSection) transferSection.hidden = false;
  createRoomBtn.disabled = false;
  joinRoomBtn.disabled = false;
  disconnectBtn.disabled = true;

  fileInput.value = '';
  if (sendWeightInput) sendWeightInput.value = '1';
  if (sendWeightValue) sendWeightValue.textContent = '1';
  if (transfersEl) transfersEl.textContent = '';
  updateSendButton();
  syncReceiveDestinationUI();
  setPeerState('');
  setCryptoState('');
  if (passphraseInput) passphraseInput.value = '';
  if (roomJoinKeyInput) roomJoinKeyInput.value = '';
  if (invitePackageInput) invitePackageInput.value = '';
  resetInvitePackageState();
  resetQrPairingUi();
  if (sharePassphraseBtn) sharePassphraseBtn.disabled = true;
  if (includePassphraseLinkInput) includePassphraseLinkInput.checked = false;
  if (includeIceLinkInput) includeIceLinkInput.checked = false;
  iceServersOverride = null;
  if (iceServersJsonInput) iceServersJsonInput.value = '';
  setIceState('');
  setStatus('');
  if (E2E_STATE) E2E_STATE.lastInboundOutcome = '';
  if (E2E_STATE) E2E_STATE.invitePackageParseState = '';

  // Ensure join link no longer contains any prior secret-bearing params.
  updateJoinLink();
}

/* ---------- Events ---------- */

if (clearTransferLedgerBtn) {
  clearTransferLedgerBtn.onclick = () => {
    const result = clearTransferLedger();
    if (result.removed > 0 && result.activeKept > 0) {
      addActivity('status', `Transfer ledger cleared (${result.removed} settled removed, ${result.activeKept} active retained)`);
    } else if (result.removed > 0) {
      addActivity('status', `Transfer ledger cleared (${result.removed} settled removed)`);
    } else if (result.activeKept > 0) {
      addActivity('status', `Transfer ledger unchanged (${result.activeKept} active in-flight)`);
    } else {
      addActivity('status', 'Transfer ledger already empty');
    }
  };
}

if (clearActivityBtn) {
  clearActivityBtn.onclick = () => {
    clearActivityTimeline();
    addActivity('status', 'Activity timeline cleared');
  };
}

if (activitySearchInput) {
  activitySearchInput.oninput = () => {
    renderActivityTimeline();
  };
}

const activityKindInputs = [
  activityKindConnInput,
  activityKindTransferInput,
  activityKindReceiptInput,
  activityKindWarnInput,
  activityKindStatusInput,
].filter(Boolean);

for (let i = 0; i < activityKindInputs.length; i++) {
  activityKindInputs[i].onchange = () => {
    renderActivityTimeline();
  };
}

if (activityKindsAllBtn) {
  activityKindsAllBtn.onclick = () => {
    for (let i = 0; i < activityKindInputs.length; i++) {
      activityKindInputs[i].checked = true;
    }
    renderActivityTimeline();
  };
}

if (activityKindsNoneBtn) {
  activityKindsNoneBtn.onclick = () => {
    for (let i = 0; i < activityKindInputs.length; i++) {
      activityKindInputs[i].checked = false;
    }
    renderActivityTimeline();
  };
}

if (copyActivityBtn) {
  copyActivityBtn.onclick = async () => {
    const visible = getVisibleActivityEntries();
    if (visible.length < 1) {
      setStatus('No visible activity to copy');
      return;
    }

    const text = buildActivityExportText(visible);
    if (!text) {
      setStatus('No visible activity to copy');
      return;
    }

    try {
      const ok = await copyText(text);
      setStatus(ok ? `Copied ${visible.length} activity line(s)` : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

if (downloadActivityTxtBtn) {
  downloadActivityTxtBtn.onclick = () => {
    const visible = getVisibleActivityEntries();
    if (visible.length < 1) {
      setStatus('No visible activity to download');
      return;
    }

    const text = buildActivityExportText(visible);
    if (!text) {
      setStatus('No visible activity to download');
      return;
    }

    const filename = `${buildActivityFileBaseName()}.txt`;
    const ok = downloadTextFile(filename, `${text}\n`, 'text/plain;charset=utf-8');
    setStatus(ok ? `Downloaded ${visible.length} activity line(s) as TXT` : 'Download failed');
  };
}

if (downloadActivityJsonBtn) {
  downloadActivityJsonBtn.onclick = () => {
    const visible = getVisibleActivityEntries();
    if (visible.length < 1) {
      setStatus('No visible activity to download');
      return;
    }

    const text = buildActivityExportJson(visible);
    if (!text) {
      setStatus('No visible activity to download');
      return;
    }

    const filename = `${buildActivityFileBaseName()}.json`;
    const ok = downloadTextFile(filename, `${text}\n`, 'application/json;charset=utf-8');
    setStatus(ok ? `Downloaded ${visible.length} activity line(s) as JSON` : 'Download failed');
  };
}

for (let i = 0; i < openDashboardEls.length; i++) {
  openDashboardEls[i].addEventListener('click', (event) => {
    event.preventDefault();
    requestDashboardView();
  });
}

for (let i = 0; i < returnLandingEls.length; i++) {
  returnLandingEls[i].addEventListener('click', (event) => {
    event.preventDefault();
    requestLandingView();
  });
}

window.addEventListener('ephera:open-dashboard', () => {
  requestDashboardView();
});

window.addEventListener('ephera:return-landing', () => {
  requestLandingView();
});

function handleFileSelectionChange() {
  const entries = buildOutboundEntriesFromInput(fileInput && fileInput.files ? fileInput.files : [], {
    preferRelativePath: false,
  });
  setPendingOutboundEntries(entries, 'files');
  if (folderInput) {
    try { folderInput.value = ''; } catch {}
  }
  updateSendButton();
}

function handleFolderSelectionChange() {
  const supportsFolderUpload = detectSenderFolderUploadCapable();
  const entries = buildOutboundEntriesFromInput(folderInput && folderInput.files ? folderInput.files : [], {
    preferRelativePath: supportsFolderUpload,
  });
  const source = inferOutboundSource(entries);
  setPendingOutboundEntries(entries, source);

  if (!supportsFolderUpload && entries.length > 0) {
    setStatus('Folder upload metadata unavailable in this browser. Staged as regular files.');
  } else if (supportsFolderUpload && source !== 'folder' && entries.length > 0) {
    setStatus('Folder hierarchy metadata unavailable for this selection. Staged as regular files.');
  }

  if (fileInput) {
    try { fileInput.value = ''; } catch {}
  }
  updateSendButton();
}

function isFileDragEvent(event) {
  const dt = event && event.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes('Files');
}

function handleSendDropDragEnter(event) {
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  sendDropzoneDragDepth += 1;
  renderSendDropzone();
}

function handleSendDropDragOver(event) {
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  if (sendDropzoneDragDepth < 1) sendDropzoneDragDepth = 1;
  renderSendDropzone();
}

function handleSendDropDragLeave(event) {
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  sendDropzoneDragDepth = Math.max(0, sendDropzoneDragDepth - 1);
  renderSendDropzone();
}

async function handleSendDrop(event) {
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  sendDropzoneDragDepth = 0;
  renderSendDropzone();

  let entries = [];
  try {
    entries = await buildOutboundEntriesFromDataTransfer(event.dataTransfer);
  } catch {
    entries = [];
  }

  if (!Array.isArray(entries) || entries.length < 1) {
    setStatus('No dropped payloads detected. Use Choose Files or Choose Folder.');
    return;
  }

  clearOutboundPickerValues();
  const source = inferOutboundSource(entries);
  setPendingOutboundEntries(entries, source);
  updateSendButton();

  const batchLabel = source === 'folder' ? 'folder payload(s)' : 'file payload(s)';
  addActivity('transfer', `Payloads staged via drop: ${entries.length} ${batchLabel}`);
  setStatus(`Staged ${entries.length} ${batchLabel} via drop`);
}

if (fileInput) fileInput.onchange = handleFileSelectionChange;
if (folderInput) folderInput.onchange = handleFolderSelectionChange;

if (pickSendFolderBtn) {
  pickSendFolderBtn.onclick = () => {
    if (!folderInput || !detectSenderFolderUploadCapable()) {
      setStatus('Folder picker unavailable');
      return;
    }
    try { folderInput.click(); } catch {}
  };
}

if (sendDropzoneEl) {
  sendDropzoneEl.addEventListener('dragenter', handleSendDropDragEnter);
  sendDropzoneEl.addEventListener('dragover', handleSendDropDragOver);
  sendDropzoneEl.addEventListener('dragleave', handleSendDropDragLeave);
  sendDropzoneEl.addEventListener('drop', (event) => {
    void handleSendDrop(event);
  });
  sendDropzoneEl.addEventListener('click', () => {
    if (!fileInput) return;
    try { fileInput.click(); } catch {}
  });
  sendDropzoneEl.addEventListener('keydown', (event) => {
    const key = String(event && event.key ? event.key : '');
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    if (!fileInput) return;
    try { fileInput.click(); } catch {}
  });
}

if (rotateRoomKeyBtn) {
  rotateRoomKeyBtn.onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus('Signaling not connected');
      return;
    }
    if (!activeRoomId) {
      setStatus('Not in a room');
      return;
    }
    if (!isLocalRoomOwner()) {
      setStatus('Owner privileges required');
      return;
    }

    const nextCandidate = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
    const payload = { type: 'rotate-room-join-key' };
    if (nextCandidate && nextCandidate !== activeRoomJoinKey) {
      payload.roomJoinKey = nextCandidate;
    }

    try {
      ws.send(JSON.stringify(payload));
      setStatus('Requested room auth key rotation');
    } catch {
      setStatus('Failed to rotate room auth key');
    }
  };
}

if (closeRoomBtn) {
  closeRoomBtn.onclick = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus('Signaling not connected');
      return;
    }
    if (!activeRoomId) {
      setStatus('Not in a room');
      return;
    }
    if (!isLocalRoomOwner()) {
      setStatus('Owner privileges required');
      return;
    }

    try {
      ws.send(JSON.stringify({ type: 'close-room' }));
      setStatus('Requested room close');
    } catch {
      setStatus('Failed to close room');
    }
  };
}

createRoomBtn.onclick = async () => {
  try { await RUNTIME_CONFIG_READY; } catch {}

  let roomId = roomIdInput.value.trim();
  if (!roomId) {
    roomId = generateRoomId();
    roomIdInput.value = roomId;
  }

  let roomJoinKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
  if (!roomJoinKey && roomJoinKeyInput) {
    roomJoinKey = generateRoomJoinKey();
    roomJoinKeyInput.value = roomJoinKey;
  }
  activeRoomJoinKey = roomJoinKey || null;
  updateJoinLink();

  let autoGenerated = false;
  if (!getLocalPassphrase() && passphraseInput) {
    passphraseInput.value = generateEphemeralPassphrase();
    onPassphraseChanged();
    autoGenerated = true;
  }

  try {
    await connectSignaling(roomId, true, roomJoinKey);
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus(autoGenerated
      ? 'Waiting for peer (passphrase + room key generated; share link)'
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
  const roomJoinKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
  if (!roomJoinKey) {
    setStatus('Room auth key required to join');
    return;
  }
  activeRoomJoinKey = roomJoinKey;

  try {
    await connectSignaling(roomId, false, roomJoinKey);
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    disconnectBtn.disabled = false;
    setStatus('Joined room, waiting for offer');
    if (E2E_STATE) E2E_STATE.signaling = 'room-joined';

    // E2E automation: signal "ready" without requiring a folder picker.
    if (IS_E2E && E2E_AUTO_READY) {
      localReady = true;
      sendReadySignal();
      renderPeerState();
      syncReceiveDestinationUI();
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

if (roomJoinKeyInput) {
  roomJoinKeyInput.oninput = () => {
    updateJoinLink();
  };
}

if (invitePackageInput) {
  invitePackageInput.oninput = () => {
    setInvitePackageState('Invite package loaded. Apply to continue.', true);
    if (E2E_STATE) E2E_STATE.invitePackageParseState = 'pending';
  };
}

if (generateRoomIdBtn && roomIdInput) {
  generateRoomIdBtn.onclick = () => {
    roomIdInput.value = generateRoomId();
    updateJoinLink();
  };
}

if (generateRoomJoinKeyBtn && roomJoinKeyInput) {
  generateRoomJoinKeyBtn.onclick = () => {
    roomJoinKeyInput.value = generateRoomJoinKey();
    updateJoinLink();
  };
}

if (launchpadHostBtn) {
  launchpadHostBtn.onclick = () => {
    if (createRoomBtn.disabled || activeRoomId || transportOpen || (ws && ws.readyState === WebSocket.OPEN)) {
      setStatus('Already connected. Disconnect first to host a new session.');
      return;
    }

    if (roomIdInput && !roomIdInput.value.trim()) {
      roomIdInput.value = generateRoomId();
    }
    const roomKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
    if (!roomKey && roomJoinKeyInput) {
      roomJoinKeyInput.value = generateRoomJoinKey();
    }
    updateJoinLink();
    createRoomBtn.click();
  };
}

if (launchpadJoinBtn) {
  launchpadJoinBtn.onclick = () => {
    if (joinRoomBtn.disabled || activeRoomId || transportOpen || (ws && ws.readyState === WebSocket.OPEN)) {
      setStatus('Already connected. Disconnect first to join another session.');
      return;
    }

    const roomId = roomIdInput ? roomIdInput.value.trim() : '';
    if (!roomId) {
      setStatus('Enter Room ID from invite package');
      try { if (roomIdInput) roomIdInput.focus(); } catch {}
      return;
    }

    const roomKey = sanitizeRoomJoinKey(roomJoinKeyInput ? roomJoinKeyInput.value : '');
    if (!roomKey) {
      setStatus('Enter Room Auth Key from invite package');
      try { if (roomJoinKeyInput) roomJoinKeyInput.focus(); } catch {}
      return;
    }

    joinRoomBtn.click();
  };
}

if (copyInvitePackageBtn) {
  copyInvitePackageBtn.onclick = async () => {
    const text = buildInvitePackageText();
    if (!text) {
      setStatus('Create a room first to generate invite package');
      return;
    }
    try {
      const ok = await copyText(text);
      setStatus(ok ? 'Invite package copied' : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

if (pasteInvitePackageBtn) {
  pasteInvitePackageBtn.onclick = async () => {
    if (!(navigator.clipboard && typeof navigator.clipboard.readText === 'function')) {
      setStatus('Clipboard read unavailable. Paste package manually.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        setStatus('Clipboard is empty');
        return;
      }
      if (invitePackageInput) invitePackageInput.value = text;
      setInvitePackageState('Invite package pasted. Apply to continue.', true);
      setStatus('Invite package pasted');
    } catch {
      setStatus('Clipboard read blocked. Paste package manually.');
    }
  };
}

if (applyInvitePackageBtn) {
  applyInvitePackageBtn.onclick = () => {
    const raw = invitePackageInput ? String(invitePackageInput.value || '') : '';
    applyInvitePackage(raw, { join: false });
  };
}

if (applyJoinInvitePackageBtn) {
  applyJoinInvitePackageBtn.onclick = () => {
    const raw = invitePackageInput ? String(invitePackageInput.value || '') : '';
    applyInvitePackage(raw, { join: true });
  };
}

if (showInviteQrBtn) {
  showInviteQrBtn.onclick = () => {
    const payload = getInviteQrPayload();
    if (!payload) {
      setStatus('Create a room first to generate invite QR');
      setQrPairingState('Invite QR unavailable until room + key are set.', false);
      return;
    }
    const ok = renderInviteQr(payload);
    if (ok) {
      setStatus('Invite QR ready');
      return;
    }
    setStatus('Failed to render invite QR');
  };
}

if (clearInviteQrBtn) {
  clearInviteQrBtn.onclick = () => {
    clearInviteQr();
    setQrPairingState('Invite QR cleared.', null);
    setStatus('Invite QR cleared');
  };
}

if (scanQrImageBtn) {
  scanQrImageBtn.onclick = () => {
    if (!scanQrImageInput) {
      setQrPairingState('QR image picker unavailable.', false);
      return;
    }
    if (!QR_SCAN_SUPPORTED) {
      setQrPairingState('QR image scan unavailable in this browser.', false);
      return;
    }
    try { scanQrImageInput.click(); } catch {}
  };
}

if (scanQrImageInput) {
  scanQrImageInput.onchange = async () => {
    const file = scanQrImageInput.files && scanQrImageInput.files[0]
      ? scanQrImageInput.files[0]
      : null;
    try {
      const ok = await scanQrFromImageFile(file);
      if (ok) setStatus('QR image scanned');
      else setStatus('QR image scan failed');
    } finally {
      try { scanQrImageInput.value = ''; } catch {}
    }
  };
}

if (startQrCameraBtn) {
  startQrCameraBtn.onclick = async () => {
    const ok = await startQrCameraScan();
    setStatus(ok ? 'Camera scan started' : 'Camera scan unavailable');
  };
}

if (stopQrCameraBtn) {
  stopQrCameraBtn.onclick = () => {
    stopQrCamera();
    setStatus('Camera scan stopped');
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
    sendReadySignal();
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
    // Re-check runtime capabilities at click time (important for tests/polyfills).
    renderPreflight();
    const pf = getPreflightState();
    if (!pf.folderSaveCapable) {
      setStatus(pf.fix || 'Folder-save unavailable in this environment. Use Ready (Discard).');
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
      syncReceiveDestinationUI();
      sendReadySignal();
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
    syncReceiveDestinationUI();
    sendReadySignal();
    setStatus('Ready to receive (discarding)');
  };
}

if (copyReceiveDestinationBtn) {
  copyReceiveDestinationBtn.onclick = async () => {
    const text = getReceiveDestinationCopyText();
    try {
      const ok = await copyText(text);
      setStatus(ok ? 'Receive destination copied' : 'Copy failed');
    } catch {
      setStatus('Copy failed');
    }
  };
}

if (openReceiveFolderBtn) {
  openReceiveFolderBtn.onclick = async () => {
    const ok = await openReceiveFolderAtCurrentDestination();
    if (ok) {
      setStatus('Opened folder picker at receive destination');
      return;
    }
    setStatus('Open folder unavailable');
  };
}

if (operatorConsoleDetailsEl) {
  operatorConsoleDetailsEl.open = !IS_E2E;
}

if (transferAdvancedDetailsEl) {
  transferAdvancedDetailsEl.open = !IS_E2E;
  transferAdvancedDetailsEl.ontoggle = () => {
    renderStateStrip();
  };
}

resetInvitePackageState();
resetQrPairingUi();
syncOutboundSelectionSummary();
renderTransferLedger();

// Initialize send gating + status strip before any user interaction.
updateSendButton();
initConsoleNav();
addActivity('conn', 'App ready');

/* ---------- E2E Automation (Test-Only) ---------- */

if (IS_E2E) {
  const roomId = PARAMS.get('roomId');
  if (roomId) roomIdInput.value = roomId;

  const roomJoinKey = sanitizeRoomJoinKey(getSecretParam('roomJoinKey', 'joinKey'));
  if (roomJoinKey && roomJoinKeyInput) {
    roomJoinKeyInput.value = roomJoinKey;
    activeRoomJoinKey = roomJoinKey;
    stripRoomJoinKeyFromUrl();
  }

  const passphrase = getSecretParam('passphrase');
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
    E2E_STATE.refreshPreflight = () => {
      try { renderStateStrip(); } catch {}
    };
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
    E2E_STATE.renderInviteQr = () => {
      try {
        const payload = getInviteQrPayload();
        if (!payload) return false;
        return renderInviteQr(payload);
      } catch {
        return false;
      }
    };
    E2E_STATE.applyQrRaw = (raw) => {
      try {
        return applyScannedQrRaw(String(raw || ''), 'e2e');
      } catch {
        return false;
      }
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

  const roomJoinKey = sanitizeRoomJoinKey(getSecretParam('roomJoinKey', 'joinKey'));
  if (roomJoinKey && roomJoinKeyInput) {
    roomJoinKeyInput.value = roomJoinKey;
    activeRoomJoinKey = roomJoinKey;
    stripRoomJoinKeyFromUrl();
  }

  const passphrase = getSecretParam('passphrase');
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
