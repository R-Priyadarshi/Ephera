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

function safeResolve(urlPath) {
  const raw = decodeURIComponent((urlPath || '/').split('?')[0] || '/');
  const rel = raw === '/' ? '/index.html' : raw;
  const p = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(CLIENT_DIR, p);
  if (!full.startsWith(CLIENT_DIR)) return null;
  return full;
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

const tls = loadTlsOrExit();
const server = tls
  ? https.createServer(tls, onRequest)
  : http.createServer(onRequest);

function onRequest(req, res) {
  const filePath = safeResolve(req.url || '/');
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
signaling = createSignalingServer({ server });

signaling.ready.catch(() => shutdown(1));
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

  try { if (signaling) await signaling.close(); } catch {}
  signaling = null;

  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });

  if (exitCode) process.exit(exitCode);
}

process.on('SIGINT', () => { shutdown(0).catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown(0).catch(() => process.exit(1)); });

