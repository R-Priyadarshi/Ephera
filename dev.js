/**
 * Ephera local dev runner.
 *
 * Starts:
 * - Static client server (http://localhost:3000 by default)
 * - WebSocket signaling (same origin by default)
 *
 * Notes:
 * - No request logging. No persistence.
 * - For receive-to-folder on other devices, use `npm run dev:secure`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createSignalingServer } = require('./server/signaling');

const ROOT = __dirname;
const CLIENT_DIR = path.join(ROOT, 'client');

const CLIENT_PORT = Number(process.env.CLIENT_PORT || 3000);
const SIGNALING_PORT = (() => {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'SIGNALING_PORT')) return CLIENT_PORT;
  const n = Number(process.env.SIGNALING_PORT);
  return Number.isFinite(n) ? n : CLIENT_PORT;
})();

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

let stopping = false;
let signaling = null;

const server = http.createServer((req, res) => {
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
    res.end(data);
  });
});

server.listen(CLIENT_PORT, '0.0.0.0', () => {
  const base = `http://localhost:${CLIENT_PORT}`;
  const clientUrl = SIGNALING_PORT === CLIENT_PORT ? base : `${base}?signalPort=${SIGNALING_PORT}`;
  console.log(`Client:    ${clientUrl}`);
  console.log(`Signaling: ws://localhost:${SIGNALING_PORT}`);
});

server.on('error', (err) => {
  if (!err || typeof err.code !== 'string') {
    process.exit(1);
    return;
  }

  if (err.code === 'EADDRINUSE') {
    console.error(`Client port ${CLIENT_PORT} is already in use.`);
    console.error('Set CLIENT_PORT to a free port, or stop the process using it.');
    shutdown(1);
    return;
  }

  console.error(err);
  shutdown(1);
});

// Start signaling after the HTTP server exists.
signaling = SIGNALING_PORT === CLIENT_PORT
  ? createSignalingServer({ server })
  : createSignalingServer({ port: SIGNALING_PORT });

signaling.ready.catch(() => {
  shutdown(1);
});

signaling.wss.on('error', () => {
  shutdown(1);
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

process.on('SIGINT', () => {
  shutdown(0).catch(() => process.exit(1));
});
process.on('SIGTERM', () => {
  shutdown(0).catch(() => process.exit(1));
});

