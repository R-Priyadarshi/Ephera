/**
 * Ephera secure dev runner (HTTPS + WSS).
 *
 * Why this exists:
 * - File System Access APIs (showDirectoryPicker) require a secure context.
 * - HTTP over a LAN IP is NOT a secure context, so saving received files won't work.
 *
 * Starts:
 * - HTTPS static client server (default https://0.0.0.0:3000)
 * - WSS signaling (same origin by default)
 *
 * TLS:
 * - If TLS_KEY_PATH and TLS_CERT_PATH are set, uses them.
 * - Otherwise auto-generates a self-signed dev cert into `.ephera-dev-tls/` (requires `openssl`).
 *
 * No request logging. No persistence. No payload diagnostics.
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { createSignalingServer } = require('./server/signaling');

const ROOT = __dirname;
const CLIENT_DIR = path.join(ROOT, 'client');

const CLIENT_PORT = Number(process.env.CLIENT_PORT || 3000);
const SIGNALING_PORT = (() => {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'SIGNALING_PORT')) return CLIENT_PORT;
  const n = Number(process.env.SIGNALING_PORT);
  return Number.isFinite(n) ? n : CLIENT_PORT;
})();

const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;

const DEV_TLS_DIR = path.join(ROOT, '.ephera-dev-tls');
const DEFAULT_TLS_KEY_PATH = path.join(DEV_TLS_DIR, 'key.pem');
const DEFAULT_TLS_CERT_PATH = path.join(DEV_TLS_DIR, 'cert.pem');

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

function sanitizeDnsName(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(s)) return null;
  if (s.length > 253) return null;
  return s;
}

function getLanIPv4() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net) continue;
      if (net.family !== 'IPv4') continue;
      if (net.internal) continue;
      if (typeof net.address === 'string' && net.address) {
        list.push(net.address);
      }
    }
  }
  return Array.from(new Set(list));
}

function readFileOrExit(label, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    console.error(`${label} path required.`);
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`${label} file not found: ${filePath}`);
    process.exit(1);
  }
  return fs.readFileSync(filePath);
}

function ensureDevTls(keyPath, certPath) {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  const sans = [];
  sans.push('DNS:localhost');
  const host = sanitizeDnsName(os.hostname());
  if (host) sans.push(`DNS:${host}`);
  sans.push('IP:127.0.0.1');

  for (const ip of getLanIPv4()) {
    sans.push(`IP:${ip}`);
    if (sans.length >= 12) break;
  }

  const args = [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '365',
    '-subj', '/CN=localhost',
    '-addext', 'basicConstraints=CA:FALSE',
    '-addext', 'keyUsage=digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
    '-addext', `subjectAltName=${sans.join(',')}`,
  ];

  const res = spawnSync('openssl', args, { stdio: 'ignore' });
  if (res.status !== 0) {
    console.error('Failed to generate dev TLS certificate.');
    console.error('Set TLS_KEY_PATH and TLS_CERT_PATH to your own certificate, or install openssl.');
    process.exit(1);
  }

  try { fs.chmodSync(keyPath, 0o600); } catch {}
  try { fs.chmodSync(certPath, 0o644); } catch {}
}

function loadTls() {
  // If either is provided, require both.
  if (TLS_KEY_PATH || TLS_CERT_PATH) {
    if (!TLS_KEY_PATH || !TLS_CERT_PATH) {
      console.error('Both TLS_KEY_PATH and TLS_CERT_PATH are required if either is set.');
      process.exit(1);
    }
    return {
      key: readFileOrExit('TLS key', TLS_KEY_PATH),
      cert: readFileOrExit('TLS cert', TLS_CERT_PATH),
    };
  }

  ensureDevTls(DEFAULT_TLS_KEY_PATH, DEFAULT_TLS_CERT_PATH);
  return {
    key: fs.readFileSync(DEFAULT_TLS_KEY_PATH),
    cert: fs.readFileSync(DEFAULT_TLS_CERT_PATH),
  };
}

const tls = loadTls();

let stopping = false;
let signaling = null;

const clientServer = https.createServer(tls, (req, res) => {
  const filePath = safeResolve(req.url || '/');
  if (!filePath) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(filePath));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(data);
  });
});

let signalingHttp = null;
if (SIGNALING_PORT !== CLIENT_PORT) {
  signalingHttp = https.createServer(tls, (_req, res) => {
    // Intentionally minimal. WebSocket upgrades are handled by ws.
    res.statusCode = 404;
    res.end('Not Found');
  });
}

// Start signaling after the servers exist.
signaling = SIGNALING_PORT === CLIENT_PORT
  ? createSignalingServer({ server: clientServer })
  : createSignalingServer({ server: signalingHttp });

signaling.ready.catch(() => {
  shutdown(1);
});

signaling.wss.on('error', () => {
  shutdown(1);
});

clientServer.listen(CLIENT_PORT, '0.0.0.0', () => {
  const base = `https://localhost:${CLIENT_PORT}`;
  const clientUrl = SIGNALING_PORT === CLIENT_PORT ? base : `${base}?signalPort=${SIGNALING_PORT}`;
  console.log(`Client (HTTPS):  ${clientUrl}`);
  const ips = getLanIPv4();
  for (const ip of ips) {
    const u = `https://${ip}:${CLIENT_PORT}`;
    console.log(`Client (LAN):    ${SIGNALING_PORT === CLIENT_PORT ? u : `${u}?signalPort=${SIGNALING_PORT}`}`);
  }
  console.log(`Signaling (WSS): wss://localhost:${SIGNALING_PORT}`);
});

clientServer.on('error', (err) => {
  if (!err || typeof err.code !== 'string') {
    process.exit(1);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`Client port ${CLIENT_PORT} is already in use.`);
    shutdown(1);
    return;
  }
  console.error(err);
  shutdown(1);
});

if (signalingHttp) {
  signalingHttp.listen(SIGNALING_PORT, '0.0.0.0', () => {});

  signalingHttp.on('error', (err) => {
    if (!err || typeof err.code !== 'string') {
      process.exit(1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`Signaling port ${SIGNALING_PORT} is already in use.`);
      shutdown(1);
      return;
    }
    console.error(err);
    shutdown(1);
  });
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  try { if (signaling) await signaling.close(); } catch {}
  signaling = null;

  await new Promise((resolve) => {
    try { clientServer.close(() => resolve()); } catch { resolve(); }
  });

  if (signalingHttp) {
    await new Promise((resolve) => {
      try { signalingHttp.close(() => resolve()); } catch { resolve(); }
    });
    signalingHttp = null;
  }

  if (exitCode) process.exit(exitCode);
}

process.on('SIGINT', () => {
  shutdown(0).catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  shutdown(0).catch(() => process.exit(1));
});

