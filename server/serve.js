/**
 * EPHERA — App Server (Static Client + Same-Origin Signaling)
 *
 * Purpose:
 * - Serve the browser client (static files)
 * - Provide a same-origin WebSocket signaling endpoint (stateless, RAM-only)
 *
 * ZERO-MEMORY GUARANTEES:
 * - No request logging
 * - No payload logging
 * - No persistence
 *
 * TLS:
 * - If TLS_KEY_PATH and TLS_CERT_PATH are set, serves HTTPS + WSS.
 * - Otherwise serves HTTP + WS (recommended behind a TLS-terminating reverse proxy).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createSignalingServer } = require('./signaling');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');

const PORT = (() => {
  const raw = Number(process.env.PORT || process.env.CLIENT_PORT || 3000);
  return Number.isFinite(raw) ? raw : 3000;
})();

const HOST = (typeof process.env.HOST === 'string' && process.env.HOST.trim())
  ? process.env.HOST.trim()
  : '0.0.0.0';

const TLS_KEY_PATH = (typeof process.env.TLS_KEY_PATH === 'string' && process.env.TLS_KEY_PATH.trim())
  ? process.env.TLS_KEY_PATH.trim()
  : '';

const TLS_CERT_PATH = (typeof process.env.TLS_CERT_PATH === 'string' && process.env.TLS_CERT_PATH.trim())
  ? process.env.TLS_CERT_PATH.trim()
  : '';

const ICE_SERVERS_JSON = (typeof process.env.ICE_SERVERS_JSON === 'string' && process.env.ICE_SERVERS_JSON.trim())
  ? process.env.ICE_SERVERS_JSON.trim()
  : '';

const ICE_TRANSPORT_POLICY = (typeof process.env.ICE_TRANSPORT_POLICY === 'string' && process.env.ICE_TRANSPORT_POLICY.trim())
  ? process.env.ICE_TRANSPORT_POLICY.trim()
  : '';

const TURN_URLS_JSON = (typeof process.env.TURN_URLS_JSON === 'string' && process.env.TURN_URLS_JSON.trim())
  ? process.env.TURN_URLS_JSON.trim()
  : '';

const TURN_AUTH_SECRET = (typeof process.env.TURN_AUTH_SECRET === 'string' && process.env.TURN_AUTH_SECRET.trim())
  ? process.env.TURN_AUTH_SECRET.trim()
  : '';

const TURN_TTL_SECONDS_RAW = (typeof process.env.TURN_TTL_SECONDS === 'string' && process.env.TURN_TTL_SECONDS.trim())
  ? process.env.TURN_TTL_SECONDS.trim()
  : '';

const ENFORCE_SAME_ORIGIN_RAW = (typeof process.env.ENFORCE_SAME_ORIGIN === 'string' && process.env.ENFORCE_SAME_ORIGIN.trim())
  ? process.env.ENFORCE_SAME_ORIGIN.trim()
  : '';

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.wasm': return 'application/wasm';
    default: return 'application/octet-stream';
  }
}

function parsePathname(urlPath) {
  try {
    return decodeURIComponent((urlPath || '/').split('?')[0] || '/');
  } catch {
    return null;
  }
}

function safeResolve(pathname) {
  if (typeof pathname !== 'string' || !pathname) return null;
  const rel = pathname === '/' ? '/index.html' : pathname;
  const p = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(CLIENT_DIR, p);
  if (!full.startsWith(CLIENT_DIR)) return null;
  return full;
}

function sanitizeIceUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.length > 512) return null;
  if (!/^(stun|stuns|turn|turns):/i.test(s)) return null;
  return s;
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value)) return null;

  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    let urls = item.urls;
    if (typeof urls === 'string') {
      const u = sanitizeIceUrl(urls);
      if (!u) continue;
      urls = u;
    } else if (Array.isArray(urls)) {
      const list = [];
      for (const rawUrl of urls) {
        const u = sanitizeIceUrl(rawUrl);
        if (!u) continue;
        list.push(u);
        if (list.length >= 8) break;
      }
      if (list.length === 0) continue;
      urls = list.length === 1 ? list[0] : list;
    } else {
      continue;
    }

    const server = { urls };
    if (typeof item.username === 'string' && item.username) {
      server.username = item.username.slice(0, 256);
    }
    if (typeof item.credential === 'string' && item.credential) {
      server.credential = item.credential.slice(0, 256);
    }
    if (typeof item.credentialType === 'string' && item.credentialType) {
      server.credentialType = item.credentialType.slice(0, 32);
    }

    out.push(server);
    if (out.length >= 8) break;
  }

  return out.length ? out : null;
}

function sanitizeTurnUrls(value) {
  if (!Array.isArray(value)) return null;

  const out = [];
  for (const rawUrl of value) {
    const u = sanitizeIceUrl(rawUrl);
    if (!u) continue;
    if (!/^turns?:/i.test(u)) continue;
    out.push(u);
    if (out.length >= 8) break;
  }

  return out.length ? out : null;
}

function cloneIceServer(server) {
  const out = {
    urls: Array.isArray(server.urls) ? server.urls.slice() : server.urls,
  };

  if (typeof server.username === 'string') out.username = server.username;
  if (typeof server.credential === 'string') out.credential = server.credential;
  if (typeof server.credentialType === 'string') out.credentialType = server.credentialType;
  return out;
}

function cloneIceServers(servers) {
  if (!Array.isArray(servers)) return null;
  return servers.map(cloneIceServer);
}

function parseTurnTtlSecondsOrExit(value, fallback = 600) {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) process.exit(1);
  const ttl = Math.floor(n);
  if (ttl < 30 || ttl > 86400) process.exit(1);
  return ttl;
}

function parseBooleanFlagOrExit(value, fallback) {
  if (!value) return fallback;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  process.exit(1);
}

function buildDynamicTurnServer(turnConfig) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = nowSeconds + turnConfig.ttlSeconds;
  const nonce = crypto.randomBytes(8).toString('hex');
  const username = `${expiresAt}:${nonce}`;
  const credential = crypto.createHmac('sha1', turnConfig.secret).update(username).digest('base64');

  return {
    urls: turnConfig.urls.length === 1 ? turnConfig.urls[0] : turnConfig.urls.slice(),
    username,
    credential,
  };
}

function loadRuntimeConfigFactoryOrExit() {
  const configBase = { v: 1 };
  let staticIceServers = null;
  let dynamicTurn = null;
  let icePolicy = null;

  if (ICE_SERVERS_JSON) {
    let parsed = null;
    try {
      parsed = JSON.parse(ICE_SERVERS_JSON);
    } catch {
      process.exit(1);
    }

    const sanitized = sanitizeIceServers(parsed);
    if (!sanitized) process.exit(1);
    staticIceServers = sanitized;
  }

  if ((TURN_URLS_JSON && !TURN_AUTH_SECRET) || (!TURN_URLS_JSON && TURN_AUTH_SECRET)) {
    process.exit(1);
  }

  if (TURN_URLS_JSON && TURN_AUTH_SECRET) {
    let parsedTurnUrls = null;
    try {
      parsedTurnUrls = JSON.parse(TURN_URLS_JSON);
    } catch {
      process.exit(1);
    }

    const sanitizedTurnUrls = sanitizeTurnUrls(parsedTurnUrls);
    if (!sanitizedTurnUrls) process.exit(1);

    dynamicTurn = {
      urls: sanitizedTurnUrls,
      secret: TURN_AUTH_SECRET,
      ttlSeconds: parseTurnTtlSecondsOrExit(TURN_TTL_SECONDS_RAW, 600),
    };
  }

  if (ICE_TRANSPORT_POLICY) {
    const policy = ICE_TRANSPORT_POLICY.toLowerCase();
    if (policy === 'relay') {
      icePolicy = 'relay';
    } else if (policy !== 'all') {
      process.exit(1);
    }
  }

  return () => {
    const config = { ...configBase };

    if (staticIceServers) {
      config.iceServers = cloneIceServers(staticIceServers);
    }

    if (dynamicTurn) {
      if (!config.iceServers) config.iceServers = [];
      config.iceServers.push(buildDynamicTurnServer(dynamicTurn));
    }

    if (icePolicy) {
      config.icePolicy = icePolicy;
    }

    return config;
  };
}

function writeJson(res, statusCode, obj) {
  setSecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    res.end(JSON.stringify(obj));
  } catch {
    res.end('{}');
  }
}

function setSecurityHeaders(res) {
  // Keep these headers conservative to avoid breaking WebRTC.
  // No request logging; no identifying headers.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Narrow CSP that still allows ws/wss signaling and module scripts.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
  ].join('; '));
}

function loadTlsOrExit() {
  if (!TLS_KEY_PATH && !TLS_CERT_PATH) return null;
  if (!TLS_KEY_PATH || !TLS_CERT_PATH) process.exit(1);

  if (!fs.existsSync(TLS_KEY_PATH)) process.exit(1);
  if (!fs.existsSync(TLS_CERT_PATH)) process.exit(1);

  return {
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH),
  };
}

const runtimeConfigFactory = loadRuntimeConfigFactoryOrExit();
const enforceSameOrigin = parseBooleanFlagOrExit(ENFORCE_SAME_ORIGIN_RAW, true);

const tls = loadTlsOrExit();
const server = tls
  ? https.createServer(tls, onRequest)
  : http.createServer(onRequest);

let signalingReady = false;

function onRequest(req, res) {
  const pathname = parsePathname(req.url || '/');
  if (!pathname) {
    res.statusCode = 400;
    setSecurityHeaders(res);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/healthz') {
    writeJson(res, 200, {
      ok: true,
      service: 'ephera-app',
      signalingReady: !!signalingReady,
      stopping: !!stopping,
    });
    return;
  }

  if (pathname === '/readyz') {
    const ready = signalingReady && !stopping;
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      signalingReady: !!signalingReady,
      stopping: !!stopping,
    });
    return;
  }

  if (pathname === '/runtime-config') {
    writeJson(res, 200, runtimeConfigFactory());
    return;
  }

  const filePath = safeResolve(pathname);
  if (!filePath) {
    res.statusCode = 400;
    setSecurityHeaders(res);
    res.end('Bad Request');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    setSecurityHeaders(res);
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(filePath));
    res.end(data);
  });
}

let stopping = false;
let signaling = null;

// Same-origin signaling is the default deployment target.
signaling = createSignalingServer({
  server,
  enforceSameOrigin,
});

signaling.ready
  .then(() => {
    signalingReady = true;
  })
  .catch(() => shutdown(1));
signaling.wss.on('error', () => shutdown(1));

server.on('error', () => shutdown(1));

server.listen(PORT, HOST, () => {
  // Intentionally silent by default.
  // Set VERBOSE=1 if you want local startup output.
  if (process.env.VERBOSE === '1') {
    const scheme = tls ? 'https' : 'http';
    const wsScheme = tls ? 'wss' : 'ws';
    // Avoid printing HOST when it's 0.0.0.0; keep it copy-paste friendly.
    const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
    // eslint-disable-next-line no-console
    console.log(`Client:    ${scheme}://${host}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Signaling: ${wsScheme}://${host}:${PORT}`);
  }
});

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  signalingReady = false;

  try { if (signaling) await signaling.close(); } catch {}
  signaling = null;

  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });

  if (exitCode) process.exit(exitCode);
}

process.on('SIGINT', () => { shutdown(0).catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown(0).catch(() => process.exit(1)); });
