/* eslint-disable no-console */
/**
 * Ephera WebRTC E2E (headless Chrome)
 *
 * Verifies:
 * - server/index.js signaling works
 * - client/index.html + client/app.js wiring works
 * - real WebRTC DataChannel opens between two browser pages
 * - a file can be streamed from sender to receiver (receiver discards)
 *
 * This is a local automation check. No GitHub push.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { createSignalingServer } = require('../server/signaling');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const SERVER_ENTRY = path.join(ROOT, 'server', 'index.js');
const APP_SERVER_ENTRY = path.join(ROOT, 'server', 'serve.js');
const DEV_SECURE_ENTRY = path.join(ROOT, 'dev-secure.js');

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

function normalizeHttpBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid E2E_APP_BASE_URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`E2E_APP_BASE_URL must start with http:// or https:// (got ${parsed.protocol})`);
  }
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function normalizeSignalUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid E2E_SIGNAL_URL: ${value}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`E2E_SIGNAL_URL must start with ws:// or wss:// (got ${parsed.protocol})`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function generateRoomJoinKey(seed = '') {
  const entropy = `${Date.now()}-${Math.random().toString(16).slice(2)}-${seed}`;
  return `e2ejoin-${Buffer.from(entropy, 'utf8').toString('hex').slice(0, 48)}`;
}

async function createCdp(page) {
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send('Runtime.enable'); } catch {}
  return cdp;
}

async function getHeapUsedBytes(cdp) {
  try {
    const res = await cdp.send('Runtime.getHeapUsage');
    const used = res && Number.isFinite(res.usedSize) ? res.usedSize : 0;
    return used > 0 ? used : 0;
  } catch {
    return 0;
  }
}

async function forceGc(page) {
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send('Runtime.enable'); } catch {}
  try { await cdp.send('HeapProfiler.enable'); } catch {}

  for (let i = 0; i < 3; i++) {
    try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
    try { await cdp.send('Runtime.collectGarbage'); } catch {}
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }

  try { await cdp.detach(); } catch {}
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await canConnect(port)) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startStaticServer() {
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
      res.end(data);
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  const { port } = server.address();
  return { server, port };
}

async function startSignalingServer(port) {
  const out = [];
  const err = [];

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  });

  proc.stdout.on('data', (d) => {
    out.push(String(d));
    if (out.join('').length > 4096) out.shift();
  });

  proc.stderr.on('data', (d) => {
    err.push(String(d));
    if (err.join('').length > 4096) err.shift();
  });

  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

  // Wait for port open or early exit.
  const ready = (async () => {
    await waitForPort(port, 5000);
    return null;
  })();

  let first;
  try {
    first = await Promise.race([exited, ready]);
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw e;
  }
  if (typeof first === 'number') {
    const msg = [
      `Signaling server exited early with code ${first}.`,
      out.length ? `stdout:\n${out.join('')}` : '',
      err.length ? `stderr:\n${err.join('')}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  return { proc, exited };
}

async function startAppServer(port, extraEnv = null) {
  const out = [];
  const err = [];

  const proc = spawn(process.execPath, [APP_SERVER_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
      HOST: '127.0.0.1',
      PORT: String(port),
      VERBOSE: '0',
    },
  });

  proc.stdout.on('data', (d) => {
    out.push(String(d));
    if (out.join('').length > 4096) out.shift();
  });

  proc.stderr.on('data', (d) => {
    err.push(String(d));
    if (err.join('').length > 4096) err.shift();
  });

  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

  const ready = (async () => {
    await waitForPort(port, 5000);
    return null;
  })();

  let first;
  try {
    first = await Promise.race([exited, ready]);
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw e;
  }
  if (typeof first === 'number') {
    const msg = [
      `App server exited early with code ${first}.`,
      out.length ? `stdout:\n${out.join('')}` : '',
      err.length ? `stderr:\n${err.join('')}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  return { proc, exited };
}

async function startSecureDevServer(port) {
  const out = [];
  const err = [];

  const proc = spawn(process.execPath, [DEV_SECURE_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLIENT_PORT: String(port),
      SIGNALING_PORT: String(port),
    },
  });

  proc.stdout.on('data', (d) => {
    out.push(String(d));
    if (out.join('').length > 8192) out.shift();
  });

  proc.stderr.on('data', (d) => {
    err.push(String(d));
    if (err.join('').length > 8192) err.shift();
  });

  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));

  const ready = (async () => {
    await waitForPort(port, 10_000);
    return null;
  })();

  let first;
  try {
    first = await Promise.race([exited, ready]);
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    throw e;
  }
  if (typeof first === 'number') {
    const msg = [
      `Secure dev server exited early with code ${first}.`,
      out.length ? `stdout:\n${out.join('')}` : '',
      err.length ? `stderr:\n${err.join('')}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  return { proc, exited };
}

async function run() {
  const { chromium } = require('playwright-core');

  const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath} (set CHROME_PATH)`);
  }

  const PERF = process.env.E2E_PERF === '1' || process.env.E2E_PERF === 'true';
  const SOAK = process.env.E2E_SOAK === '1' || process.env.E2E_SOAK === 'true';
  const FAST = process.env.E2E_FAST === '1' || process.env.E2E_FAST === 'true';
  const remoteFlag = parseBool(process.env.E2E_REMOTE, false);
  const REMOTE_APP_BASE_URL = normalizeHttpBaseUrl(process.env.E2E_APP_BASE_URL || process.env.E2E_BASE_URL || '');
  const REMOTE_SIGNAL_URL = normalizeSignalUrl(process.env.E2E_SIGNAL_URL || '');
  const REMOTE_IGNORE_HTTPS_ERRORS = parseBool(process.env.E2E_REMOTE_IGNORE_HTTPS_ERRORS, true);
  const REMOTE_MODE = remoteFlag || !!REMOTE_APP_BASE_URL;
  const RELAY_RUNTIME = process.env.E2E_RELAY_RUNTIME === '1' || process.env.E2E_RELAY_RUNTIME === 'true';
  const RELAY_REQUIRED = process.env.E2E_RELAY_REQUIRED === '1' || process.env.E2E_RELAY_REQUIRED === 'true';
  const RELAY_TURN_URL = String(process.env.E2E_TURN_URL || '').trim();
  const RELAY_TURN_URL_TCP = String(process.env.E2E_TURN_URL_TCP || '').trim();
  const RELAY_TURN_USERNAME = String(process.env.E2E_TURN_USERNAME || process.env.E2E_TURN_USER || '').trim();
  const RELAY_TURN_CREDENTIAL = String(process.env.E2E_TURN_CREDENTIAL || process.env.E2E_TURN_PASS || '').trim();
  const RELAY_TURN_AUTH_SECRET = String(process.env.E2E_TURN_AUTH_SECRET || '').trim();
  const RELAY_TURN_TTL_SECONDS_RAW = String(process.env.E2E_TURN_TTL_SECONDS || '').trim();
  const relayHasStaticCreds = !!(RELAY_TURN_USERNAME && RELAY_TURN_CREDENTIAL);
  const relayHasDynamicSecret = !!RELAY_TURN_AUTH_SECRET;
  const relayUseDynamicCredentials = relayHasDynamicSecret;
  const relayUseStaticCredentials = !relayUseDynamicCredentials && relayHasStaticCreds;

  const relayTurnTtlSeconds = (() => {
    if (!RELAY_TURN_TTL_SECONDS_RAW) return 600;
    const raw = Number(RELAY_TURN_TTL_SECONDS_RAW);
    if (!Number.isFinite(raw)) {
      throw new Error('Invalid E2E_TURN_TTL_SECONDS (must be a number between 30 and 86400).');
    }
    const n = Math.floor(raw);
    if (n < 30 || n > 86400) {
      throw new Error('Invalid E2E_TURN_TTL_SECONDS (must be between 30 and 86400).');
    }
    return n;
  })();

  if (RELAY_REQUIRED && !RELAY_RUNTIME) {
    throw new Error('E2E_RELAY_REQUIRED=1 requires E2E_RELAY_RUNTIME=1.');
  }

  if (REMOTE_MODE && !REMOTE_APP_BASE_URL) {
    throw new Error('Remote E2E requires E2E_APP_BASE_URL.');
  }

  if (REMOTE_MODE && RELAY_RUNTIME) {
    throw new Error('Remote E2E does not support E2E_RELAY_RUNTIME. Run relay validation locally.');
  }

  if (RELAY_RUNTIME) {
    if (!RELAY_TURN_URL) {
      throw new Error([
        'Relay runtime E2E requested but E2E_TURN_URL is missing.',
        'Required: E2E_TURN_URL.',
      ].join(' '));
    }
    if (relayHasDynamicSecret && relayHasStaticCreds) {
      throw new Error([
        'Relay runtime E2E config is ambiguous.',
        'Use dynamic TURN auth (E2E_TURN_AUTH_SECRET) OR static TURN auth',
        '(E2E_TURN_USERNAME + E2E_TURN_CREDENTIAL), not both.',
      ].join(' '));
    }
    if (!relayUseDynamicCredentials && !relayUseStaticCredentials) {
      throw new Error([
        'Relay runtime E2E requested but TURN auth config is incomplete.',
        'Use one mode:',
        '- Dynamic: E2E_TURN_AUTH_SECRET (recommended)',
        '- Static: E2E_TURN_USERNAME + E2E_TURN_CREDENTIAL',
      ].join(' '));
    }
  }
  const SOAK_IDLE_MS = (() => {
    if (!SOAK) return 0;
    const raw = Number(process.env.E2E_IDLE_MS || 60_000);
    if (!Number.isFinite(raw) || raw <= 0) return 60_000;
    return Math.min(30 * 60_000, Math.max(1000, Math.floor(raw)));
  })();
  const SOAK_CYCLES = (() => {
    if (!SOAK) return 0;
    const raw = Number(process.env.E2E_CYCLES || 20);
    if (!Number.isFinite(raw) || raw <= 0) return 20;
    return Math.min(200, Math.max(1, Math.floor(raw)));
  })();

  let staticServer = null;
  let sameOriginSignaling = null;
  let signaling = null;
  let appServer = null;
  let relayAppServer = null;
  let secureServer = null;
  let baseUrl = REMOTE_APP_BASE_URL;
  let signalUrl = REMOTE_SIGNAL_URL;
  let appBaseUrl = REMOTE_APP_BASE_URL;
  let relayAppBaseUrl = '';
  let secureBaseUrl = REMOTE_APP_BASE_URL;

  if (!REMOTE_MODE) {
    staticServer = await startStaticServer();
    sameOriginSignaling = createSignalingServer({ server: staticServer.server, pingIntervalMs: 0 });
    const signalPort = await getFreePort();
    signaling = await startSignalingServer(signalPort);
    const appPort = await getFreePort();
    appServer = await startAppServer(appPort);
    const securePort = await getFreePort();
    secureServer = await startSecureDevServer(securePort);

    baseUrl = `http://127.0.0.1:${staticServer.port}`;
    signalUrl = `ws://127.0.0.1:${signalPort}`;
    appBaseUrl = `http://127.0.0.1:${appPort}`;
    secureBaseUrl = `https://127.0.0.1:${securePort}`;

    if (RELAY_RUNTIME) {
      const relayPort = await getFreePort();
      const relayUrls = [RELAY_TURN_URL];
      if (RELAY_TURN_URL_TCP) relayUrls.push(RELAY_TURN_URL_TCP);
      const relayEnv = {
        ICE_TRANSPORT_POLICY: 'relay',
      };
      if (relayUseDynamicCredentials) {
        relayEnv.TURN_URLS_JSON = JSON.stringify(relayUrls);
        relayEnv.TURN_AUTH_SECRET = RELAY_TURN_AUTH_SECRET;
        relayEnv.TURN_TTL_SECONDS = String(relayTurnTtlSeconds);
      } else {
        const relayIceServers = [
          {
            urls: relayUrls.length === 1 ? relayUrls[0] : relayUrls,
            username: RELAY_TURN_USERNAME,
            credential: RELAY_TURN_CREDENTIAL,
          },
        ];
        relayEnv.ICE_SERVERS_JSON = JSON.stringify(relayIceServers);
      }

      relayAppServer = await startAppServer(relayPort, relayEnv);
      relayAppBaseUrl = `http://127.0.0.1:${relayPort}`;
    }
  } else {
    console.log(`--- E2E MODE: REMOTE (${REMOTE_APP_BASE_URL}) ---`);
    if (REMOTE_SIGNAL_URL) {
      console.log(`--- E2E REMOTE SIGNAL OVERRIDE: ${REMOTE_SIGNAL_URL} ---`);
    } else {
      console.log('--- E2E REMOTE SIGNALING: same-origin default ---');
    }
  }

  const fileSize = 512 * 1024; // 512 KB
  const fileBuf = Buffer.allocUnsafe(fileSize);
  for (let i = 0; i < fileSize; i++) fileBuf[i] = i & 0xff;

  const fileSize2 = 128 * 1024; // 128 KB
  const fileBuf2 = Buffer.allocUnsafe(fileSize2);
  for (let i = 0; i < fileSize2; i++) fileBuf2[i] = (i * 7) & 0xff;

  function computeBufferDigest(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum = (sum + buf[i]) >>> 0;
    return {
      size: buf.length >>> 0,
      sum: sum >>> 0,
      first16: Array.from(buf.subarray(0, 16)),
      last16: Array.from(buf.subarray(Math.max(0, buf.length - 16))),
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ephera-e2e-'));
  const filePathSingle = path.join(tmpDir, 'e2e.bin');
  const filePathA = path.join(tmpDir, 'a.bin');
  const filePathB = path.join(tmpDir, 'b.bin');
  const filePathCrash = path.join(tmpDir, 'crash.bin');
  const filePathPerfLarge = path.join(tmpDir, 'perf-large.bin');
  const folderBatchRoot = path.join(tmpDir, 'payload-folder');
  const folderBatchFileAPath = path.join(folderBatchRoot, 'docs', 'guide.bin');
  const folderBatchFileBPath = path.join(folderBatchRoot, 'media', 'clip.bin');
  const folderBatchRelA = 'payload-folder/docs/guide.bin';
  const folderBatchRelB = 'payload-folder/media/clip.bin';
  const folderBatchDigestA = computeBufferDigest(fileBuf);
  const folderBatchDigestB = computeBufferDigest(fileBuf2);
  fs.writeFileSync(filePathSingle, fileBuf);
  fs.writeFileSync(filePathA, fileBuf);
  fs.writeFileSync(filePathB, fileBuf2);
  fs.mkdirSync(path.dirname(folderBatchFileAPath), { recursive: true });
  fs.mkdirSync(path.dirname(folderBatchFileBPath), { recursive: true });
  fs.writeFileSync(folderBatchFileAPath, fileBuf);
  fs.writeFileSync(folderBatchFileBPath, fileBuf2);
  // Larger file to ensure the transfer is in-flight when signaling is killed.
  fs.writeFileSync(filePathCrash, Buffer.alloc(32 * 1024 * 1024, 0x5a));
  if (PERF) {
    // Manual gates ask for 100MB transfers. Keep this behind PERF mode
    // so default `npm run e2e` stays fast.
    fs.writeFileSync(filePathPerfLarge, Buffer.alloc(100 * 1024 * 1024, 0x33));
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });

  try {
    const defaultContextOptions = (REMOTE_MODE && REMOTE_IGNORE_HTTPS_ERRORS)
      ? { ignoreHTTPSErrors: true }
      : {};

    async function newContext(extraOptions = null) {
      const merged = {
        ...defaultContextOptions,
        ...(extraOptions && typeof extraOptions === 'object' ? extraOptions : {}),
      };
      return browser.newContext(merged);
    }

    async function stagePayloadsViaDrop(page, selector, files) {
      const payloads = [];
      const list = Array.isArray(files) ? files : [];

      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (typeof item === 'string') {
          payloads.push({
            name: path.basename(item),
            mimeType: 'application/octet-stream',
            bytes: Array.from(fs.readFileSync(item)),
          });
          continue;
        }

        if (item && typeof item === 'object' && item.buffer) {
          payloads.push({
            name: item.name || `drop-${i}.bin`,
            mimeType: item.mimeType || 'application/octet-stream',
            bytes: Array.from(item.buffer),
          });
        }
      }

      const dt = await page.evaluateHandle((items) => {
        const data = new DataTransfer();
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const bytes = new Uint8Array(Array.isArray(item.bytes) ? item.bytes : []);
          const file = new File([bytes], item.name || `drop-${i}.bin`, {
            type: item.mimeType || 'application/octet-stream',
          });
          data.items.add(file);
        }
        return data;
      }, payloads);

      try {
        await page.dispatchEvent(selector, 'dragenter', { dataTransfer: dt });
        await page.dispatchEvent(selector, 'dragover', { dataTransfer: dt });
        await page.dispatchEvent(selector, 'drop', { dataTransfer: dt });
      } finally {
        try { await dt.dispose(); } catch {}
      }
    }

    async function readTransferLedgerSnapshot(page) {
      return page.evaluate(() => {
        const parseCount = (id) => {
          const el = document.getElementById(id);
          const text = el ? String(el.textContent || '') : '';
          const match = text.match(/(\d+)/);
          return match ? Number(match[1]) : 0;
        };

        const cards = Array.from(document.querySelectorAll('#transfer-ledger-list .ledger-entry'));
        return {
          count: cards.length,
          active: parseCount('transfer-ledger-active-count'),
          complete: parseCount('transfer-ledger-complete-count'),
          attention: parseCount('transfer-ledger-attention-count'),
          text: cards.map((card) => String(card.textContent || '')).join('\n'),
        };
      });
    }

    function assertLedgerContainsPayloads(label, ledger, expectedNames) {
      const text = String(ledger && ledger.text ? ledger.text : '');
      const allNamesPresent = expectedNames.every((name) => text.includes(name));
      if (allNamesPresent) return;

      const visibleNames = expectedNames.slice(0, Math.min(3, expectedNames.length));
      let headVisible = true;
      for (const name of visibleNames) {
        if (!text.includes(name)) {
          headVisible = false;
          break;
        }
      }

      if (headVisible && expectedNames.length > visibleNames.length) {
        const moreLabel = `+${expectedNames.length - visibleNames.length} more`;
        if (!text.includes(moreLabel)) {
          throw new Error(`${label} ledger missing collapsed payload indicator ${JSON.stringify(moreLabel)}: ${JSON.stringify(ledger)}`);
        }
      }
      if (headVisible) return;

      // Receiver ledger may retain only the newest settled entries once the cap
      // is reached. In that case, assert visibility of tail payload names.
      const ledgerCount = Math.max(0, Number(ledger && ledger.count) || 0);
      if (ledgerCount > 0 && expectedNames.length > ledgerCount) {
        const tailVisible = expectedNames
          .slice(-Math.min(3, expectedNames.length))
          .every((name) => text.includes(name));
        if (tailVisible) return;
      }

      throw new Error(`${label} ledger missing visible payload names for expected batch: ${JSON.stringify(ledger)}`);
    }

    async function runScenario({
      label,
      passphrase,
      files,
      selectionMode = 'input',
      folderInputPath = '',
      expectSelectionSummaryIncludes = '',
      expectSelectionSummaryExcludes = '',
      expectSenderFolderUploadCapable = null,
      expectAutoPassphrase = false,
      mismatchPassphrase = false,
      expectSendDisabled = false,
      expectDisabledReason = '',
      skipPeerReadyWait = false,
      closeReceiverSignaling = false,
      killSignaling = false,
      restartSignaling = false,
      sameOrigin = false,
      baseUrlOverride = '',
      signalUrlOverride = '',
      senderExtraQuery = '',
      receiverExtraQuery = '',
      recvDelayMs = 0,
      checkGc = false,
      expectReceipt = false,
      transferTimeoutMs = 60_000,
      perf = null,
      idleMsBeforeSend = 0,
      contextOptions = null,
      expectRelayPolicy = false,
      onSendStarted = null,
    }) {
      const activeBaseUrl = baseUrlOverride || baseUrl;
      const activeSignalUrl = signalUrlOverride || signalUrl;
      const shouldUseSameOrigin = sameOrigin || !activeSignalUrl;
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretParams = new URLSearchParams();
      secretParams.set('roomJoinKey', roomJoinKey);
      if (passphrase) secretParams.set('passphrase', passphrase);
      const secretHash = secretParams.toString() ? `#${secretParams.toString()}` : '';

      const sigQ = shouldUseSameOrigin ? '' : `&signalUrl=${encodeURIComponent(activeSignalUrl)}`;
      const normalizeExtraQuery = (value) => {
        const s = String(value || '').trim();
        if (!s) return '';
        return s.startsWith('&') ? s : `&${s}`;
      };
      const senderExtraQ = normalizeExtraQuery(senderExtraQuery);
      const receiverExtraQ = normalizeExtraQuery(receiverExtraQuery);

      const senderUrl = `${activeBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${sigQ}${senderExtraQ}${secretHash}`;
      const recvDelay = Number.isFinite(recvDelayMs) && recvDelayMs > 0 ? `&recvDelayMs=${Math.floor(recvDelayMs)}` : '';
      const receiverUrl = `${activeBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${sigQ}${recvDelay}${receiverExtraQ}${secretHash}`;

      const fileList = (Array.isArray(files) && files.length > 0) ? files : [filePathSingle];
      const expectedCount = fileList.length;
      const expectedNames = fileList.map((f) => (typeof f === 'string' ? path.basename(f) : f.name));
      const expectedTotalBytes = fileList.reduce((sum, f) => {
        if (typeof f === 'string') return sum + fs.statSync(f).size;
        return sum + (f && f.buffer ? f.buffer.length : 0);
      }, 0);

      const senderCtx = await newContext(contextOptions || {});
      const receiverCtx = await newContext(contextOptions || {});

      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      let senderCdp = null;
      let receiverCdp = null;
      let perfState = null;
      let stopPerf = null;
      let perfPromise = null;

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 10_000 }
        );

        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });
        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 10_000 }
        );

        if (expectRelayPolicy) {
          console.log(`--- E2E (${label}): verifying relay policy from runtime config ---`);
          await Promise.all([
            sender.waitForFunction(() => {
              const c = document.getElementById('ice-relay-only');
              return !!(c && c.checked === true);
            }, null, { timeout: 10_000 }),
            receiver.waitForFunction(() => {
              const c = document.getElementById('ice-relay-only');
              return !!(c && c.checked === true);
            }, null, { timeout: 10_000 }),
          ]);
        }

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);
        console.log(`--- E2E (${label}): checking preflight contract ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.preflightWebRTC === true, null, { timeout: 10_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.preflightWebRTC === true, null, { timeout: 10_000 }),
        ]);
        const [senderPreflight, receiverPreflight] = await Promise.all([
          sender.evaluate(() => {
            const s = window.__epheraE2E;
            const btn = document.getElementById('pick-receive-folder');
            return {
              folderSaveCapable: s ? s.preflightFolderSaveCapable : null,
              hasFolderSaveField: !!(s && typeof s.preflightFolderSaveCapable === 'boolean'),
              senderFolderUploadCapable: s ? s.preflightSenderFolderUploadCapable : null,
              hasSenderFolderUploadField: !!(s && typeof s.preflightSenderFolderUploadCapable === 'boolean'),
              buttonDisabled: !!(btn && btn.disabled),
            };
          }),
          receiver.evaluate(() => {
            const s = window.__epheraE2E;
            const btn = document.getElementById('pick-receive-folder');
            return {
              folderSaveCapable: s ? s.preflightFolderSaveCapable : null,
              hasFolderSaveField: !!(s && typeof s.preflightFolderSaveCapable === 'boolean'),
              senderFolderUploadCapable: s ? s.preflightSenderFolderUploadCapable : null,
              hasSenderFolderUploadField: !!(s && typeof s.preflightSenderFolderUploadCapable === 'boolean'),
              buttonDisabled: !!(btn && btn.disabled),
            };
          }),
        ]);
        for (const side of [
          { name: 'sender', data: senderPreflight },
          { name: 'receiver', data: receiverPreflight },
        ]) {
          if (!side.data || side.data.hasFolderSaveField !== true) {
            throw new Error(`Missing preflightFolderSaveCapable boolean on ${side.name}: ${JSON.stringify(side.data)}`);
          }
          if (!side.data || side.data.hasSenderFolderUploadField !== true) {
            throw new Error(`Missing preflightSenderFolderUploadCapable boolean on ${side.name}: ${JSON.stringify(side.data)}`);
          }
          const expectedDisabled = !side.data.folderSaveCapable;
          if (side.data.buttonDisabled !== expectedDisabled) {
            throw new Error(
              `Preflight/button mismatch on ${side.name}: folderSaveCapable=${side.data.folderSaveCapable}, buttonDisabled=${side.data.buttonDisabled}`
            );
          }
        }
        if (typeof expectSenderFolderUploadCapable === 'boolean') {
          if (senderPreflight.senderFolderUploadCapable !== expectSenderFolderUploadCapable) {
            throw new Error(
              `Sender folder upload capability mismatch: expected ${expectSenderFolderUploadCapable}, got ${senderPreflight.senderFolderUploadCapable}`
            );
          }
        }
        console.log(`--- E2E (${label}): checking quick-mode defaults ---`);
        await Promise.all([
          sender.waitForFunction(() => {
            const d = document.getElementById('transfer-advanced');
            return !!(d && d.open === false);
          }, null, { timeout: 10_000 }),
          receiver.waitForFunction(() => {
            const d = document.getElementById('transfer-advanced');
            return !!(d && d.open === false);
          }, null, { timeout: 10_000 }),
        ]);
        console.log(`--- E2E (${label}): checking role-aware onboarding hints ---`);
        await Promise.all([
          sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.onboardingRole === 'owner' && String(window.__epheraE2E.onboardingHint || '').toLowerCase().includes('owner hint'),
            null,
            { timeout: 10_000 }
          ),
          receiver.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.onboardingRole === 'peer' && String(window.__epheraE2E.onboardingHint || '').toLowerCase().includes('peer hint'),
            null,
            { timeout: 10_000 }
          ),
        ]);
        console.log(`--- E2E (${label}): checking receive destination default ---`);
        await receiver.waitForFunction(
          () => {
            const s = window.__epheraE2E;
            if (!s) return false;
            const modeOk = s.receiveDestinationMode === 'discard';
            const label = String(s.receiveDestinationLabel || '').toLowerCase();
            return modeOk && label.includes('discard mode');
          },
          null,
          { timeout: 10_000 }
        );

        if (!skipPeerReadyWait) {
          console.log(`--- E2E (${label}): waiting for peer ready ---`);
          await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });
        }

        if (!passphrase && expectAutoPassphrase) {
          console.log(`--- E2E (${label}): using auto-generated passphrase ---`);
          const autoPass = await sender.evaluate(() => (document.getElementById('passphrase') || {}).value || '');
          if (!autoPass) throw new Error('Expected sender passphrase to be auto-generated');

          const recvPass = mismatchPassphrase ? `${autoPass}-mismatch` : autoPass;
          await receiver.evaluate((p) => {
            const el = document.getElementById('passphrase');
            if (!el) throw new Error('passphrase input not found');
            el.value = p;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, recvPass);

          await sender.waitForFunction(
            () => (document.getElementById('crypto-state') || {}).textContent.includes('peer=passphrase'),
            null,
            { timeout: 10_000 }
          );
        }

        if (!passphrase && !expectAutoPassphrase) {
          // Stage 6/UX hardening: initiator auto-generates a passphrase. For the
          // plain scenario we intentionally clear it to validate non-passphrase mode.
          await sender.evaluate(() => {
            const btn = document.getElementById('clear-passphrase');
            if (btn) btn.click();
          });
        }

        console.log(`--- E2E (${label}): ICE restart (renegotiation) ---`);
        await sender.evaluate(() => window.__epheraE2E && window.__epheraE2E.restartIce && window.__epheraE2E.restartIce());
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.restartCount >= 1 && window.__epheraE2E.restartInFlight === false,
          null,
          { timeout: 20_000 }
        );

        if (restartSignaling) {
          if (!signaling || !signaling.proc) {
            throw new Error(`Scenario ${label} requires a local signaling process and cannot run in remote mode.`);
          }
          console.log(`--- E2E (${label}): restarting signaling server ---`);
          try { signaling.proc.kill('SIGKILL'); } catch {}
          await withTimeout(signaling.exited, 5000);

          await Promise.all([
            sender.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.signalingConnected === false,
              null,
              { timeout: 10_000 }
            ),
            receiver.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.signalingConnected === false,
              null,
              { timeout: 10_000 }
            ),
          ]);

          signaling = await startSignalingServer(signalPort);

          await Promise.all([
            sender.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.signalingConnected === true,
              null,
              { timeout: 20_000 }
            ),
            receiver.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.signalingConnected === true,
              null,
              { timeout: 20_000 }
            ),
          ]);

          console.log(`--- E2E (${label}): ICE restart after signaling reconnect ---`);
          await sender.evaluate(() => window.__epheraE2E && window.__epheraE2E.restartIce && window.__epheraE2E.restartIce());
          await sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.restartCount >= 2 && window.__epheraE2E.restartInFlight === false,
            null,
            { timeout: 20_000 }
          );
        }

        if (closeReceiverSignaling) {
          console.log(`--- E2E (${label}): closing receiver signaling (peer-left) ---`);
          await receiver.evaluate(() => window.__epheraE2E && window.__epheraE2E.closeSignaling && window.__epheraE2E.closeSignaling());
          await sleep(150);
        }

        if (Number.isFinite(idleMsBeforeSend) && idleMsBeforeSend > 0) {
          console.log(`--- E2E (${label}): idling for ${idleMsBeforeSend}ms ---`);
          await sleep(Math.floor(idleMsBeforeSend));
        }

        if (!expectSendDisabled) {
          console.log(`--- E2E (${label}): validating guided flow pre-send state ---`);
          await sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.flowStep === 5 && window.__epheraE2E.flowReady === false,
            null,
            { timeout: 10_000 }
          );
        }

        console.log(`--- E2E (${label}): selecting payloads + sending ---`);
        if (selectionMode === 'drop') {
          await stagePayloadsViaDrop(sender, '#send-dropzone', fileList);
          await sender.waitForFunction(
            () => {
              const txt = (document.getElementById('send-selection-summary') || {}).textContent || '';
              return String(txt).toLowerCase() !== 'no payload selected.';
            },
            null,
            { timeout: 10_000 }
          );
          console.log(`--- E2E (${label}): payloads dropped into send bay ---`);
        } else if (selectionMode === 'folder-input') {
          const folderTarget = String(folderInputPath || '').trim();
          await sender.setInputFiles('#folder-input', folderTarget || fileList);
          console.log(`--- E2E (${label}): folder input selected ---`);
        } else {
          await sender.setInputFiles('#file-input', fileList);
          console.log(`--- E2E (${label}): files selected ---`);
        }

        if (expectSelectionSummaryIncludes) {
          const needle = String(expectSelectionSummaryIncludes).toLowerCase();
          await sender.waitForFunction(
            (n) => {
              const txt = (document.getElementById('send-selection-summary') || {}).textContent || '';
              return String(txt).toLowerCase().includes(String(n || ''));
            },
            needle,
            { timeout: 10_000 }
          );
        }
        if (expectSelectionSummaryExcludes) {
          const needle = String(expectSelectionSummaryExcludes).toLowerCase();
          await sender.waitForFunction(
            (n) => {
              const txt = (document.getElementById('send-selection-summary') || {}).textContent || '';
              return !String(txt).toLowerCase().includes(String(n || ''));
            },
            needle,
            { timeout: 10_000 }
          );
        }

        if (!expectSendDisabled) {
          await sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.flowReady === true,
            null,
            { timeout: 10_000 }
          );
          await sender.waitForFunction(
            () => window.__epheraE2E && String(window.__epheraE2E.quickSummary || '').toLowerCase().includes('ready to send'),
            null,
            { timeout: 10_000 }
          );
          await sender.waitForFunction(
            () => window.__epheraE2E && String(window.__epheraE2E.onboardingHint || '').toLowerCase().includes('ready to send'),
            null,
            { timeout: 10_000 }
          );
        }

        if (expectSendDisabled) {
          const disabledNow = await sender.evaluate(() => document.getElementById('send-file').disabled);
          if (!disabledNow) throw new Error('Expected send to remain disabled (likely passphrase mismatch gate failed)');
          await sleep(1500);
          const stillDisabled = await sender.evaluate(() => document.getElementById('send-file').disabled);
          if (!stillDisabled) throw new Error('Expected send to remain disabled (button became enabled unexpectedly)');
          if (expectDisabledReason) {
            const needle = String(expectDisabledReason).toLowerCase();
            await sender.waitForFunction(
              (n) => {
                const txt = (document.getElementById('send-gate-reason') || {}).textContent || '';
                return String(txt).toLowerCase().includes(String(n || ''));
              },
              needle,
              { timeout: 5_000 }
            );
            const reason = await sender.evaluate(() => (document.getElementById('send-gate-reason') || {}).textContent || '');
            if (!String(reason).toLowerCase().includes(needle)) {
              throw new Error(`Expected disabled reason to include "${expectDisabledReason}", got "${reason}"`);
            }
          }
          console.log(`--- E2E (${label}) PASS: send stayed disabled as expected ---`);
          return;
        }

        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 10_000 });
        console.log(`--- E2E (${label}): send enabled ---`);

        if (perf && perf.enabled) {
          // Force GC so baselines are comparable.
          await Promise.allSettled([forceGc(sender), forceGc(receiver)]);

          senderCdp = await createCdp(sender);
          receiverCdp = await createCdp(receiver);

          const baseSender = await getHeapUsedBytes(senderCdp);
          const baseReceiver = await getHeapUsedBytes(receiverCdp);
          perfState = {
            baseSender,
            baseReceiver,
            maxSender: baseSender,
            maxReceiver: baseReceiver,
            maxBufferedAmount: 0,
          };

          const pollMs = Number.isFinite(perf.pollMs) ? Math.max(25, Math.floor(perf.pollMs)) : 100;
          const getBuffered = async () => {
            try {
              const n = await sender.evaluate(() => {
                const s = window.__epheraE2E;
                if (!s || typeof s.getBufferedAmount !== 'function') return 0;
                return s.getBufferedAmount();
              });
              return Number.isFinite(n) ? n : 0;
            } catch {
              return 0;
            }
          };

          let stop = false;
          stopPerf = () => { stop = true; };
          perfPromise = (async () => {
            while (!stop) {
              // Sample heap + bufferedAmount.
              const [hs, hr, ba] = await Promise.all([
                getHeapUsedBytes(senderCdp),
                getHeapUsedBytes(receiverCdp),
                getBuffered(),
              ]);

              if (hs > perfState.maxSender) perfState.maxSender = hs;
              if (hr > perfState.maxReceiver) perfState.maxReceiver = hr;
              if (ba > perfState.maxBufferedAmount) perfState.maxBufferedAmount = ba;

              // eslint-disable-next-line no-await-in-loop
              await sleep(pollMs);
            }
          })();
        }

        await sender.evaluate(() => document.getElementById('send-file').click());
        console.log(`--- E2E (${label}): send clicked ---`);

        if (typeof onSendStarted === 'function') {
          await onSendStarted({
            sender,
            receiver,
            label,
            expectedCount,
            expectedNames,
            expectedTotalBytes,
            readTransferLedgerSnapshot,
          });
        }

        if (killSignaling) {
          if (!signaling || !signaling.proc) {
            throw new Error(`Scenario ${label} requires a local signaling process and cannot run in remote mode.`);
          }
          // Try to ensure the transfer actually started, then kill the signaling server.
          try {
            await sender.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.sentBytes > 0 && window.__epheraE2E.sentDoneCount === 0,
              null,
              { timeout: 5_000 }
            );
          } catch {}

          console.log(`--- E2E (${label}): killing signaling server ---`);
          try { signaling.proc.kill('SIGKILL'); } catch {}
          await sleep(50);
        }

        console.log(`--- E2E (${label}): waiting for send/receive completion ---`);
        try {
          await Promise.all([
            sender.waitForFunction(
              (n) => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= n,
              expectedCount,
              { timeout: transferTimeoutMs }
            ),
            receiver.waitForFunction(
              (n) => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= n,
              expectedCount,
              { timeout: transferTimeoutMs }
            ),
          ]);
        } catch (err) {
          const senderState = await withTimeout(sender.evaluate(() => window.__epheraE2E).catch(() => null), 2000);
          const receiverState = await withTimeout(receiver.evaluate(() => window.__epheraE2E).catch(() => null), 2000);
          const msg = [
            `E2E wait timed out (${label}).`,
            senderState ? `senderState=${JSON.stringify(senderState)}` : 'senderState=<unavailable>',
            receiverState ? `receiverState=${JSON.stringify(receiverState)}` : 'receiverState=<unavailable>',
            err && err.message ? `error=${err.message}` : String(err),
          ].join('\n');
          throw new Error(msg);
        }

        const senderState = await sender.evaluate(() => window.__epheraE2E);
        const receiverState = await receiver.evaluate(() => window.__epheraE2E);

        if (senderState.error) throw new Error(`Sender error: ${senderState.error}`);
        if (receiverState.error) throw new Error(`Receiver error: ${receiverState.error}`);

        if (senderState.sentTotalBytes !== expectedTotalBytes) {
          throw new Error(`Sender sentTotalBytes mismatch: expected ${expectedTotalBytes}, got ${senderState.sentTotalBytes}`);
        }

        if (receiverState.recvTotalBytes !== expectedTotalBytes) {
          throw new Error(`Receiver recvTotalBytes mismatch: expected ${expectedTotalBytes}, got ${receiverState.recvTotalBytes}`);
        }

        if (receiverState.receiveDestinationMode !== 'discard') {
          throw new Error(`Expected discard destination mode, got ${receiverState.receiveDestinationMode}`);
        }

        if (expectedCount === 1) {
          const expectedName = expectedNames[0];

          if (senderState.sentBytes !== expectedTotalBytes) {
            throw new Error(`Sender sentBytes mismatch: expected ${expectedTotalBytes}, got ${senderState.sentBytes}`);
          }

          if (receiverState.recvBytes !== expectedTotalBytes) {
            throw new Error(`Receiver recvBytes mismatch: expected ${expectedTotalBytes}, got ${receiverState.recvBytes}`);
          }

          if (receiverState.recvTitle !== expectedName) {
            throw new Error(`Receiver recvTitle mismatch: expected ${JSON.stringify(expectedName)}, got ${JSON.stringify(receiverState.recvTitle)}`);
          }

          const inboundOutcome = String(receiverState.lastInboundOutcome || '').toLowerCase();
          if (!inboundOutcome.includes('discarded ->')) {
            throw new Error(`Expected discard inbound outcome, got ${JSON.stringify(receiverState.lastInboundOutcome)}`);
          }
        } else {
          const titles = Array.isArray(receiverState.recvTitles) ? receiverState.recvTitles : [];
          for (const name of expectedNames) {
            if (!titles.includes(name)) {
              throw new Error(`Receiver recvTitles missing: ${JSON.stringify(name)} (got ${JSON.stringify(titles)})`);
            }
          }
        }

        const [senderLedger, receiverLedger] = await Promise.all([
          readTransferLedgerSnapshot(sender),
          readTransferLedgerSnapshot(receiver),
        ]);

        if (!senderLedger || senderLedger.count < 1) {
          throw new Error(`Sender ledger missing entries: ${JSON.stringify(senderLedger)}`);
        }
        if (!receiverLedger || receiverLedger.count < 1) {
          throw new Error(`Receiver ledger missing entries: ${JSON.stringify(receiverLedger)}`);
        }
        if (receiverLedger.complete < 1) {
          throw new Error(`Receiver ledger did not mark completion: ${JSON.stringify(receiverLedger)}`);
        }
        assertLedgerContainsPayloads('Sender', senderLedger, expectedNames);
        assertLedgerContainsPayloads('Receiver', receiverLedger, expectedNames);

        console.log(`--- E2E (${label}) PASS: ${expectedTotalBytes} bytes transferred over WebRTC P2P (${expectedCount} file(s)) ---`);

        if (stopPerf) stopPerf();
        if (perfPromise) await Promise.allSettled([perfPromise]);

        if (perfState && senderCdp && receiverCdp && perf && perf.enabled) {
          await Promise.allSettled([forceGc(sender), forceGc(receiver)]);
          const postSender = await getHeapUsedBytes(senderCdp);
          const postReceiver = await getHeapUsedBytes(receiverCdp);

          const maxBuffered = perfState.maxBufferedAmount;
          const maxBufferedLimit = Number.isFinite(perf.maxBufferedAmountBytes) ? perf.maxBufferedAmountBytes : 0;

          const maxHeapGrowth = Number.isFinite(perf.maxHeapGrowthBytes) ? perf.maxHeapGrowthBytes : 0;
          const postSlack = Number.isFinite(perf.postGcHeapSlackBytes) ? perf.postGcHeapSlackBytes : 0;

          const senderGrowth = perfState.maxSender - perfState.baseSender;
          const receiverGrowth = perfState.maxReceiver - perfState.baseReceiver;

          console.log(`--- E2E (${label}): perf baseline heap sender=${perfState.baseSender} receiver=${perfState.baseReceiver} ---`);
          console.log(`--- E2E (${label}): perf max heap sender=${perfState.maxSender} receiver=${perfState.maxReceiver} ---`);
          console.log(`--- E2E (${label}): perf post-GC heap sender=${postSender} receiver=${postReceiver} ---`);
          console.log(`--- E2E (${label}): perf max bufferedAmount=${maxBuffered} ---`);

          if (maxBufferedLimit > 0 && maxBuffered > maxBufferedLimit) {
            throw new Error(`Perf FAIL (${label}): max bufferedAmount ${maxBuffered} > limit ${maxBufferedLimit}`);
          }
          if (maxHeapGrowth > 0) {
            if (senderGrowth > maxHeapGrowth) {
              throw new Error(`Perf FAIL (${label}): sender heap growth ${senderGrowth} > limit ${maxHeapGrowth}`);
            }
            if (receiverGrowth > maxHeapGrowth) {
              throw new Error(`Perf FAIL (${label}): receiver heap growth ${receiverGrowth} > limit ${maxHeapGrowth}`);
            }
          }
          if (postSlack > 0) {
            if (postSender > perfState.baseSender + postSlack) {
              throw new Error(`Perf FAIL (${label}): sender post-GC heap ${postSender} > baseline+slack ${perfState.baseSender + postSlack}`);
            }
            if (postReceiver > perfState.baseReceiver + postSlack) {
              throw new Error(`Perf FAIL (${label}): receiver post-GC heap ${postReceiver} > baseline+slack ${perfState.baseReceiver + postSlack}`);
            }
          }
        }

        if (expectReceipt) {
          console.log(`--- E2E (${label}): waiting for delivery receipts ---`);
          await sender.waitForFunction(
            (n) => window.__epheraE2E && window.__epheraE2E.deliveredCount >= n,
            expectedCount,
            { timeout: 15_000 }
          );

          const s = await sender.evaluate(() => window.__epheraE2E);
          if (!s) throw new Error('Missing sender __epheraE2E state');
          if (s.deliveredCount !== expectedCount) {
            throw new Error(`Receipt count mismatch: expected ${expectedCount}, got ${s.deliveredCount}`);
          }
          // E2E receiver runs in discard mode (autoReady, no folder picker).
          if (s.deliveredDiscardCount !== expectedCount) {
            throw new Error(`Receipt sink mismatch: expected discard=${expectedCount}, got discard=${s.deliveredDiscardCount}`);
          }

          const senderLedgerAfterReceipt = await readTransferLedgerSnapshot(sender);
          if (!senderLedgerAfterReceipt || senderLedgerAfterReceipt.complete < 1) {
            throw new Error(`Sender ledger did not mark completion after receipt: ${JSON.stringify(senderLedgerAfterReceipt)}`);
          }
        }

        if (checkGc) {
          console.log(`--- E2E (${label}): disconnect + forced GC ---`);

          await Promise.allSettled([
            sender.evaluate(() => window.__epheraE2E && window.__epheraE2E.disconnect && window.__epheraE2E.disconnect()),
            receiver.evaluate(() => window.__epheraE2E && window.__epheraE2E.disconnect && window.__epheraE2E.disconnect()),
          ]);

          await sleep(200);

          // Receiver owns TransferSession instances; force GC there and assert collectability.
          await forceGc(receiver);

          const gcState = await receiver.evaluate(() => {
            const s = window.__epheraE2E;
            if (!s) return null;
            const refs = Array.isArray(s.sessionWeakRefs) ? s.sessionWeakRefs : [];
            const alive = refs.filter((r) => r && typeof r.deref === 'function' && r.deref() !== undefined).length;
            return { totalRefs: refs.length, alive };
          });

          if (!gcState) throw new Error('GC check: missing __epheraE2E state');
          if (gcState.totalRefs < expectedCount) {
            throw new Error(`GC check: expected >=${expectedCount} session WeakRefs, got ${gcState.totalRefs}`);
          }
          if (gcState.alive !== 0) {
            throw new Error(`GC check: expected 0 live TransferSession refs after GC, got ${gcState.alive}`);
          }

          console.log(`--- E2E (${label}): GC PASS (sessions collectible) ---`);
        }
      } finally {
        if (stopPerf) stopPerf();
        if (perfPromise) await Promise.allSettled([perfPromise]);
        try { if (senderCdp) await senderCdp.detach(); } catch {}
        try { if (receiverCdp) await receiverCdp.detach(); } catch {}
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runSenderCloseMidTransferScenario() {
      const label = 'sender-close-mid-transfer';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${secretHash}`;

      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 10_000 }
        );

        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });
        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 10_000 }
        );

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        console.log(`--- E2E (${label}): waiting for peer ready ---`);
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });

        console.log(`--- E2E (${label}): syncing auto-generated passphrase ---`);
        const autoPass = await sender.evaluate(() => (document.getElementById('passphrase') || {}).value || '');
        if (!autoPass) throw new Error('Expected sender passphrase to be auto-generated');

        await receiver.evaluate((p) => {
          const el = document.getElementById('passphrase');
          if (!el) throw new Error('passphrase input not found');
          el.value = p;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, autoPass);

        await sender.waitForFunction(
          () => (document.getElementById('crypto-state') || {}).textContent.includes('peer=passphrase'),
          null,
          { timeout: 10_000 }
        );

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathCrash]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 10_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        // Ensure the receiver is actually receiving before killing the sender.
        try {
          await receiver.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.recvBytes > 0 && window.__epheraE2E.recvDoneCount === 0,
            null,
            { timeout: 10_000 }
          );
        } catch {}

        console.log(`--- E2E (${label}): closing sender page mid-transfer ---`);
        try { await senderCtx.close(); } catch {}

        console.log(`--- E2E (${label}): waiting for receiver abort ---`);
        await receiver.waitForFunction(
          () => window.__epheraE2E && (window.__epheraE2E.recvAbortCount >= 1 || window.__epheraE2E.error),
          null,
          { timeout: 20_000 }
        );

        const receiverState = await receiver.evaluate(() => window.__epheraE2E);
        if (receiverState.recvDoneCount !== 0) {
          throw new Error(`Expected recvDoneCount=0, got ${receiverState.recvDoneCount}`);
        }
        if (receiverState.recvAbortCount < 1) {
          throw new Error(`Expected recvAbortCount>=1, got ${receiverState.recvAbortCount}`);
        }

        console.log(`--- E2E (${label}) PASS: receiver aborted and did not hang ---`);
      } finally {
        try { await receiverCtx.close(); } catch {}
        try { await senderCtx.close(); } catch {}
      }
    }

    async function runReceiverCancelMidTransferScenario() {
      const label = 'receiver-cancel-mid-transfer';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${secretHash}`;

      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 10_000 }
        );

        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });
        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 10_000 }
        );

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        console.log(`--- E2E (${label}): waiting for peer ready ---`);
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });

        // Plain mode: receiver autoReady advertises crypto=none, so clear the auto-generated passphrase on the initiator.
        await sender.evaluate(() => {
          const btn = document.getElementById('clear-passphrase');
          if (btn) btn.click();
        });

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathCrash]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 10_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        // Ensure the transfer is in-flight.
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.sentBytes > 0 && window.__epheraE2E.sentDoneCount === 0,
          null,
          { timeout: 10_000 }
        );
        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.recvBytes > 0 && window.__epheraE2E.recvDoneCount === 0,
          null,
          { timeout: 10_000 }
        );

        console.log(`--- E2E (${label}): cancelling on receiver ---`);
        await receiver.waitForFunction(() => {
          const btn = document.querySelector('.transfer-in .transfer-cancel');
          return btn && !btn.disabled && !btn.hidden;
        }, null, { timeout: 10_000 });
        await receiver.evaluate(() => {
          const btn = document.querySelector('.transfer-in .transfer-cancel');
          if (btn) btn.click();
        });

        console.log(`--- E2E (${label}): waiting for sender abort ---`);
        await sender.waitForFunction(
          () => window.__epheraE2E && (window.__epheraE2E.sentAbortCount >= 1 || window.__epheraE2E.error),
          null,
          { timeout: 20_000 }
        );

        const senderState = await sender.evaluate(() => window.__epheraE2E);
        if (senderState.sentDoneCount !== 0) {
          throw new Error(`Expected sentDoneCount=0, got ${senderState.sentDoneCount}`);
        }
        if (senderState.sentAbortCount < 1) {
          throw new Error(`Expected sentAbortCount>=1, got ${senderState.sentAbortCount}`);
        }

        console.log(`--- E2E (${label}) PASS: receiver cancel aborted sender ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runConnectDisconnectCyclesScenario({ cycles = 5 } = {}) {
      const label = 'connect-disconnect-cycles';

      // One pair of pages; no reload. This catches cleanup regressions.
      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&autoReady=1`;

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });

        let sentBase = await sender.evaluate(() => (window.__epheraE2E && window.__epheraE2E.sentDoneCount) || 0);
        let recvBase = await receiver.evaluate(() => (window.__epheraE2E && window.__epheraE2E.recvDoneCount) || 0);

        for (let i = 0; i < cycles; i++) {
          const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}-${i}`;
          const roomJoinKey = generateRoomJoinKey(`${label}-${i}`);

          console.log(`--- E2E (${label}): cycle ${i + 1}/${cycles} ---`);

          await Promise.all([
            sender.evaluate(({ rid, rkey }) => {
              const el = document.getElementById('room-id');
              if (!el) throw new Error('room-id input missing');
              el.value = rid;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              const key = document.getElementById('room-join-key');
              if (!key) throw new Error('room-join-key input missing');
              key.value = rkey;
              key.dispatchEvent(new Event('input', { bubbles: true }));
            }, { rid: roomId, rkey: roomJoinKey }),
            receiver.evaluate(({ rid, rkey }) => {
              const el = document.getElementById('room-id');
              if (!el) throw new Error('room-id input missing');
              el.value = rid;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              const key = document.getElementById('room-join-key');
              if (!key) throw new Error('room-join-key input missing');
              key.value = rkey;
              key.dispatchEvent(new Event('input', { bubbles: true }));
            }, { rid: roomId, rkey: roomJoinKey }),
          ]);

          // Reset per-cycle signaling markers so we can await cleanly.
          await Promise.all([
            sender.evaluate(() => { if (window.__epheraE2E) window.__epheraE2E.signaling = null; }),
            receiver.evaluate(() => { if (window.__epheraE2E) window.__epheraE2E.signaling = null; }),
          ]);

          // Create must happen before join; otherwise join can race and fail "Join unavailable".
          await sender.evaluate(() => document.getElementById('create-room').click());
          await sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
            null,
            { timeout: 10_000 }
          );

          await receiver.evaluate(() => document.getElementById('join-room').click());
          await receiver.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
            null,
            { timeout: 10_000 }
          );

          await Promise.all([
            sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
            receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          ]);

          await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });

          // Sync auto-generated passphrase.
          const autoPass = await sender.evaluate(() => (document.getElementById('passphrase') || {}).value || '');
          if (!autoPass) throw new Error('Expected sender passphrase to be auto-generated');

          await receiver.evaluate((p) => {
            const el = document.getElementById('passphrase');
            if (!el) throw new Error('passphrase input not found');
            el.value = p;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, autoPass);

          await sender.waitForFunction(
            () => (document.getElementById('crypto-state') || {}).textContent.includes('peer=passphrase'),
            null,
            { timeout: 10_000 }
          );

          // One small file per cycle.
          const file = {
            name: `cycle-${i}.bin`,
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(64 * 1024, i & 0xff),
          };

          await sender.setInputFiles('#file-input', [file]);
          await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 10_000 });
          await sender.evaluate(() => document.getElementById('send-file').click());

          sentBase += 1;
          recvBase += 1;

          await Promise.all([
            sender.waitForFunction((n) => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= n, sentBase, { timeout: 30_000 }),
            receiver.waitForFunction((n) => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= n, recvBase, { timeout: 30_000 }),
          ]);

          // Disconnect both; ensure state is reset for next cycle.
          await Promise.allSettled([
            sender.evaluate(() => window.__epheraE2E && window.__epheraE2E.disconnect && window.__epheraE2E.disconnect()),
            receiver.evaluate(() => window.__epheraE2E && window.__epheraE2E.disconnect && window.__epheraE2E.disconnect()),
          ]);

          await Promise.all([
            sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === false, null, { timeout: 10_000 }),
            receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === false, null, { timeout: 10_000 }),
          ]);
        }

        // Forced GC leak check after repeated cycles.
        await forceGc(receiver);
        const gcState = await receiver.evaluate(() => {
          const s = window.__epheraE2E;
          if (!s) return null;
          const refs = Array.isArray(s.sessionWeakRefs) ? s.sessionWeakRefs : [];
          const alive = refs.filter((r) => r && typeof r.deref === 'function' && r.deref() !== undefined).length;
          return { totalRefs: refs.length, alive };
        });

        if (!gcState) throw new Error('GC check: missing __epheraE2E state');
        if (gcState.alive !== 0) {
          throw new Error(`GC check after cycles: expected 0 live TransferSession refs, got ${gcState.alive}`);
        }

        console.log(`--- E2E (${label}) PASS: ${cycles} cycles completed (sessions collectible) ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runJoinLinkAutojoinScenario() {
      const label = 'join-link-autojoin';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;

      const senderCtx = await newContext();
      const receiverCtx = await newContext();

      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        // Use normal mode here (no e2e=1) to exercise the real join-link flow.
        // Use same-origin signaling so this scenario stays independent from the
        // external signaling process (which is intentionally killed earlier).
        await sender.goto(`${baseUrl}/index.html`, { waitUntil: 'domcontentloaded' });

        // Set room ID and ensure join link will include passphrase.
        await sender.evaluate((id) => {
          const room = document.getElementById('room-id');
          if (!room) throw new Error('room-id input not found');
          room.value = id;
          room.dispatchEvent(new Event('input', { bubbles: true }));

          const includePass = document.getElementById('include-passphrase-link');
          if (includePass) {
            includePass.checked = true;
            includePass.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, roomId);

        await sender.evaluate(() => {
          const btn = document.getElementById('create-room');
          if (!btn) throw new Error('create-room button not found');
          btn.click();
        });

        await sender.waitForFunction(() => {
          const dis = document.getElementById('disconnect');
          const create = document.getElementById('create-room');
          return dis && create && dis.disabled === false && create.disabled === true;
        }, null, { timeout: 20_000 });

        const joinLink = await sender.evaluate(() => (document.getElementById('join-link') || {}).value || '');
        if (!joinLink) throw new Error('Expected join link to be populated');
        const parsedJoinLink = new URL(joinLink);
        if (parsedJoinLink.searchParams.get('autojoin') !== '1') throw new Error('Expected join link to include autojoin=1');
        if (!parsedJoinLink.searchParams.get('roomId')) throw new Error('Expected join link to include roomId');
        if (parsedJoinLink.searchParams.has('roomJoinKey') || parsedJoinLink.searchParams.has('joinKey')) {
          throw new Error('Expected join link to keep roomJoinKey out of query params');
        }
        if (parsedJoinLink.searchParams.has('passphrase')) {
          throw new Error('Expected join link to keep passphrase out of query params');
        }
        const joinHash = new URLSearchParams(parsedJoinLink.hash.replace(/^#/, ''));
        if (!joinHash.get('roomJoinKey')) throw new Error('Expected join link hash to include roomJoinKey');
        if (!joinHash.get('passphrase')) throw new Error('Expected join link hash to include passphrase (test sets checkbox)');

        console.log(`--- E2E (${label}): opening join link on receiver (should auto-join) ---`);
        await receiver.goto(joinLink, { waitUntil: 'domcontentloaded' });
        await receiver.waitForFunction(() => {
          const u = new URL(location.href);
          const h = new URLSearchParams(String(u.hash || '').replace(/^#/, ''));
          const secrets = ['roomJoinKey', 'joinKey', 'passphrase'];
          for (const k of secrets) {
            if (u.searchParams.has(k)) return false;
            if (h.has(k)) return false;
          }
          return true;
        }, null, { timeout: 10_000 });

        await receiver.waitForFunction(() => {
          const dis = document.getElementById('disconnect');
          const join = document.getElementById('join-room');
          return dis && join && dis.disabled === false && join.disabled === true;
        }, null, { timeout: 20_000 });

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => (document.getElementById('status') || {}).textContent.includes('P2P connected'), null, { timeout: 20_000 }),
          receiver.waitForFunction(() => (document.getElementById('status') || {}).textContent.includes('P2P connected'), null, { timeout: 20_000 }),
        ]);

        // Receiver becomes ready (discard mode). This is still user action, even in auto-join flow.
        await receiver.evaluate(() => {
          const btn = document.getElementById('ready-discard');
          if (!btn) throw new Error('ready-discard button not found');
          btn.click();
        });

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathSingle]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        // Receiver discards, so we expect "received" and sender to eventually show delivered/discarded.
        await receiver.waitForFunction(
          () => (document.getElementById('transfers') || {}).textContent.includes('received'),
          null,
          { timeout: 60_000 }
        );
        await sender.waitForFunction(
          () => (document.getElementById('transfers') || {}).textContent.includes('delivered'),
          null,
          { timeout: 60_000 }
        );

        console.log(`--- E2E (${label}) PASS: join link auto-joined and transfer succeeded ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runInvitePackageApplyScenario() {
      const label = 'invite-package-apply-join';
      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(`${appBaseUrl}/index.html?e2e=1`, { waitUntil: 'domcontentloaded' });
        await receiver.goto(`${appBaseUrl}/index.html?e2e=1`, { waitUntil: 'domcontentloaded' });

        console.log(`--- E2E (${label}): host creates room from launchpad ---`);
        await sender.evaluate(() => {
          const host = document.getElementById('launchpad-host');
          if (!host) throw new Error('launchpad-host button not found');
          host.click();
        });

        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 20_000 }
        );
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.invitePackageReady === true,
          null,
          { timeout: 10_000 }
        );

        const senderContract = await sender.evaluate(() => {
          const roomId = (document.getElementById('room-id') || {}).value || '';
          const roomJoinKey = (document.getElementById('room-join-key') || {}).value || '';
          const joinLink = (document.getElementById('join-link') || {}).value || '';
          const passphrase = (document.getElementById('passphrase') || {}).value || '';
          if (!roomId || !roomJoinKey || !joinLink || !passphrase) return null;
          return { roomId, roomJoinKey, joinLink, passphrase };
        });
        if (!senderContract) throw new Error('Sender contract fields missing');

        const invitePackage = [
          'Ephera Invite Package',
          `Room ID: ${senderContract.roomId}`,
          `Room Auth Key: ${senderContract.roomJoinKey}`,
          `Join Link: ${senderContract.joinLink}`,
          `Passphrase: ${senderContract.passphrase}`,
        ].join('\n');

        console.log(`--- E2E (${label}): receiver applies invite package and joins ---`);
        await receiver.evaluate((text) => {
          const input = document.getElementById('invite-package-input');
          const applyJoin = document.getElementById('apply-join-invite-package');
          if (!input) throw new Error('invite-package-input not found');
          if (!applyJoin) throw new Error('apply-join-invite-package button not found');
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          applyJoin.click();
        }, invitePackage);

        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 20_000 }
        );
        await receiver.waitForFunction(() => {
          const u = new URL(location.href);
          const h = new URLSearchParams(String(u.hash || '').replace(/^#/, ''));
          const secrets = ['roomJoinKey', 'joinKey', 'passphrase'];
          for (const k of secrets) {
            if (u.searchParams.has(k)) return false;
            if (h.has(k)) return false;
          }
          return true;
        }, null, { timeout: 10_000 });
        await receiver.waitForFunction(
          () => window.__epheraE2E
            && window.__epheraE2E.invitePackageAppliedCount >= 1
            && window.__epheraE2E.invitePackageParseState === 'ok',
          null,
          { timeout: 10_000 }
        );

        const receiverContract = await receiver.evaluate(() => {
          const roomId = (document.getElementById('room-id') || {}).value || '';
          const roomJoinKey = (document.getElementById('room-join-key') || {}).value || '';
          const passphrase = (document.getElementById('passphrase') || {}).value || '';
          return { roomId, roomJoinKey, passphrase };
        });
        if (receiverContract.roomId !== senderContract.roomId) {
          throw new Error(`Receiver roomId mismatch: expected ${senderContract.roomId}, got ${receiverContract.roomId}`);
        }
        if (receiverContract.roomJoinKey !== senderContract.roomJoinKey) {
          throw new Error('Receiver roomJoinKey mismatch');
        }
        if (receiverContract.passphrase !== senderContract.passphrase) {
          throw new Error('Receiver passphrase mismatch');
        }

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        await receiver.evaluate(() => {
          const btn = document.getElementById('ready-discard');
          if (!btn) throw new Error('ready-discard button not found');
          btn.click();
        });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.peerReady === true,
          null,
          { timeout: 15_000 }
        );

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathSingle]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 1, null, { timeout: 60_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 1, null, { timeout: 60_000 }),
        ]);

        console.log(`--- E2E (${label}) PASS: invite package apply+join path transferred successfully ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runInviteQrPairingScenario({
      label = 'invite-qr-pairing',
      senderExtraQuery = '',
      receiverExtraQuery = '',
      expectedEngine = '',
    } = {}) {
      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        const normalizeExtraQuery = (value) => {
          const s = String(value || '').trim();
          if (!s) return '';
          return s.startsWith('&') ? s : `&${s}`;
        };
        const senderExtraQ = normalizeExtraQuery(senderExtraQuery);
        const receiverExtraQ = normalizeExtraQuery(receiverExtraQuery);

        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(`${appBaseUrl}/index.html?e2e=1${senderExtraQ}`, { waitUntil: 'domcontentloaded' });
        await receiver.goto(`${appBaseUrl}/index.html?e2e=1${receiverExtraQ}`, { waitUntil: 'domcontentloaded' });

        console.log(`--- E2E (${label}): host creates room and renders invite QR ---`);
        await sender.evaluate(() => {
          const host = document.getElementById('launchpad-host');
          if (!host) throw new Error('launchpad-host button not found');
          host.click();
        });

        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 20_000 }
        );

        const qr = await sender.evaluate(() => {
          const show = document.getElementById('show-invite-qr');
          if (!show) throw new Error('show-invite-qr button not found');
          show.click();

          const e2e = window.__epheraE2E || {};
          const canvas = document.getElementById('invite-qr-canvas');
          const dataUrl = canvas && !canvas.hidden && typeof canvas.toDataURL === 'function'
            ? canvas.toDataURL('image/png')
            : '';
          return {
            payload: String(e2e.qrPayload || ''),
            visible: !!(canvas && !canvas.hidden),
            dataUrl,
          };
        });

        if (!qr || !qr.visible || !qr.payload || !qr.dataUrl) {
          throw new Error(`Expected visible invite QR with payload, got ${JSON.stringify(qr)}`);
        }

        const m = String(qr.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
        if (!m || !m[1]) throw new Error('Invite QR data URL is not PNG base64');
        const qrPath = path.join(tmpDir, `${label}.png`);
        fs.writeFileSync(qrPath, Buffer.from(m[1], 'base64'));

        const receiverScanContract = await receiver.evaluate(() => {
          const s = window.__epheraE2E || {};
          return {
            supported: !!s.qrScanSupported,
          };
        });

        console.log(`--- E2E (${label}): receiver scanning QR ---`);
        if (receiverScanContract.supported) {
          await receiver.setInputFiles('#scan-qr-image-input', [qrPath]);
        } else {
          // Fallback for environments without BarcodeDetector: exercise the same
          // QR apply path via test hook so flow stays deterministic.
          await receiver.evaluate((raw) => {
            const s = window.__epheraE2E;
            if (!s || typeof s.applyQrRaw !== 'function') throw new Error('applyQrRaw hook unavailable');
            const ok = s.applyQrRaw(raw);
            if (!ok) throw new Error('applyQrRaw failed');
          }, qr.payload);
        }

        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 20_000 }
        );

        if (receiverScanContract.supported) {
          if (expectedEngine) {
            await receiver.waitForFunction(
              (engine) => {
                const s = window.__epheraE2E;
                return !!(s && s.qrLastScanStatus === 'ok' && s.qrScanEngine === engine);
              },
              expectedEngine,
              { timeout: 10_000 }
            );
          } else {
            await receiver.waitForFunction(
              () => window.__epheraE2E && window.__epheraE2E.qrLastScanStatus === 'ok',
              null,
              { timeout: 10_000 }
            );
          }
        }

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        await receiver.evaluate(() => {
          const btn = document.getElementById('ready-discard');
          if (!btn) throw new Error('ready-discard button not found');
          btn.click();
        });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.peerReady === true,
          null,
          { timeout: 15_000 }
        );

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathSingle]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 1, null, { timeout: 60_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 1, null, { timeout: 60_000 }),
        ]);

        console.log(`--- E2E (${label}) PASS: invite QR pairing path transferred successfully ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runInviteQrInvalidImageScenario({
      label = 'invite-qr-invalid-image',
      receiverExtraQuery = '',
    } = {}) {
      const ctx = await newContext();
      const page = await ctx.newPage();

      try {
        const normalizeExtraQuery = (value) => {
          const s = String(value || '').trim();
          if (!s) return '';
          return s.startsWith('&') ? s : `&${s}`;
        };
        const receiverExtraQ = normalizeExtraQuery(receiverExtraQuery);

        console.log(`--- E2E (${label}): launching page ---`);
        await page.goto(`${appBaseUrl}/index.html?e2e=1${receiverExtraQ}`, { waitUntil: 'domcontentloaded' });

        const scanSupported = await page.evaluate(() => {
          const s = window.__epheraE2E || {};
          return !!s.qrScanSupported;
        });
        if (!scanSupported) {
          console.log(`--- E2E (${label}): SKIP (QR scan unsupported in this browser/runtime) ---`);
          return;
        }

        const invalidPngPath = path.join(tmpDir, `${label}.png`);
        // 1x1 white PNG; valid image but no QR payload.
        fs.writeFileSync(
          invalidPngPath,
          Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6QxuoAAAAASUVORK5CYII=', 'base64')
        );

        console.log(`--- E2E (${label}): scanning non-QR image ---`);
        await page.setInputFiles('#scan-qr-image-input', [invalidPngPath]);

        await page.waitForFunction(() => {
          const s = window.__epheraE2E;
          if (!s) return false;
          return s.qrLastScanStatus === 'empty' || s.qrLastScanStatus === 'error';
        }, null, { timeout: 10_000 });

        const scanState = await page.evaluate(() => {
          const s = window.__epheraE2E || {};
          return {
            source: String(s.qrLastScanSource || ''),
            status: String(s.qrLastScanStatus || ''),
            signaling: String(s.signaling || ''),
          };
        });

        if (scanState.source !== 'image') {
          throw new Error(`Expected QR scan source=image, got ${JSON.stringify(scanState)}`);
        }
        if (scanState.status !== 'empty' && scanState.status !== 'error') {
          throw new Error(`Expected QR invalid-image status empty|error, got ${JSON.stringify(scanState)}`);
        }
        if (scanState.signaling === 'room-joined') {
          throw new Error('Invalid QR image must not join room');
        }

        console.log(`--- E2E (${label}) PASS: invalid image rejected without session side effects ---`);
      } finally {
        try { await ctx.close(); } catch {}
      }
    }

    async function runInviteQrCameraScanScenario({
      label = 'invite-qr-camera-scan',
      senderExtraQuery = '',
      receiverExtraQuery = '',
      expectedEngine = '',
    } = {}) {
      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        const normalizeExtraQuery = (value) => {
          const s = String(value || '').trim();
          if (!s) return '';
          return s.startsWith('&') ? s : `&${s}`;
        };
        const senderExtraQ = normalizeExtraQuery(senderExtraQuery);
        const receiverExtraQ = normalizeExtraQuery(receiverExtraQuery);

        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(`${appBaseUrl}/index.html?e2e=1${senderExtraQ}`, { waitUntil: 'domcontentloaded' });
        await receiver.goto(`${appBaseUrl}/index.html?e2e=1${receiverExtraQ}`, { waitUntil: 'domcontentloaded' });

        console.log(`--- E2E (${label}): host creates room and renders invite QR ---`);
        await sender.evaluate(() => {
          const host = document.getElementById('launchpad-host');
          if (!host) throw new Error('launchpad-host button not found');
          host.click();
        });

        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
          null,
          { timeout: 20_000 }
        );

        const qr = await sender.evaluate(() => {
          const show = document.getElementById('show-invite-qr');
          if (!show) throw new Error('show-invite-qr button not found');
          show.click();

          const e2e = window.__epheraE2E || {};
          const canvas = document.getElementById('invite-qr-canvas');
          const dataUrl = canvas && !canvas.hidden && typeof canvas.toDataURL === 'function'
            ? canvas.toDataURL('image/png')
            : '';
          return {
            payload: String(e2e.qrPayload || ''),
            visible: !!(canvas && !canvas.hidden),
            dataUrl,
          };
        });

        if (!qr || !qr.visible || !qr.payload || !qr.dataUrl) {
          throw new Error(`Expected visible invite QR with payload, got ${JSON.stringify(qr)}`);
        }

        console.log(`--- E2E (${label}): installing fake camera QR stream ---`);
        const cameraContract = await receiver.evaluate(async (qrDataUrl) => {
          const e2e = window.__epheraE2E || {};
          const scanSupported = !!e2e.qrScanSupported;
          const hasMedia = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
          const canCapture = !!(
            typeof HTMLCanvasElement !== 'undefined'
            && HTMLCanvasElement.prototype
            && typeof HTMLCanvasElement.prototype.captureStream === 'function'
          );
          if (!scanSupported || !hasMedia || !canCapture) {
            return {
              ok: false,
              reason: 'unsupported-runtime',
              scanSupported,
              hasMedia,
              canCapture,
            };
          }

          const img = await new Promise((resolve, reject) => {
            const v = new Image();
            v.onload = () => resolve(v);
            v.onerror = () => reject(new Error('failed to load QR image'));
            v.src = qrDataUrl;
          });

          const canvas = document.createElement('canvas');
          canvas.width = 420;
          canvas.height = 420;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            return { ok: false, reason: 'canvas-context-unavailable' };
          }

          let raf = 0;
          const drawFrame = () => {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 20, 20, canvas.width - 40, canvas.height - 40);
            raf = requestAnimationFrame(drawFrame);
          };
          drawFrame();

          const stream = canvas.captureStream(12);
          const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
          if (!stream || tracks.length < 1) {
            if (raf) cancelAnimationFrame(raf);
            return { ok: false, reason: 'stream-unavailable' };
          }

          const media = navigator.mediaDevices;
          const original = media.getUserMedia.bind(media);
          media.getUserMedia = async () => stream;
          window.__epheraFakeCamera = { media, original, stream, raf };
          return { ok: true };
        }, qr.dataUrl);

        if (!cameraContract || !cameraContract.ok) {
          console.log(`--- E2E (${label}): SKIP (${cameraContract ? cameraContract.reason : 'unknown'}) ---`);
          return;
        }

        console.log(`--- E2E (${label}): start camera scan and wait for auto-join ---`);
        await receiver.evaluate(() => {
          const btn = document.getElementById('start-qr-camera');
          if (!btn) throw new Error('start-qr-camera button not found');
          btn.click();
        });

        if (expectedEngine) {
          await receiver.waitForFunction(
            (engine) => {
              const s = window.__epheraE2E;
              return !!(s && s.qrLastScanSource === 'camera' && s.qrLastScanStatus === 'ok' && s.qrScanEngine === engine);
            },
            expectedEngine,
            { timeout: 20_000 }
          );
        } else {
          await receiver.waitForFunction(
            () => {
              const s = window.__epheraE2E;
              return !!(s && s.qrLastScanSource === 'camera' && s.qrLastScanStatus === 'ok');
            },
            null,
            { timeout: 20_000 }
          );
        }

        await receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
          null,
          { timeout: 20_000 }
        );

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        await receiver.evaluate(() => {
          const btn = document.getElementById('ready-discard');
          if (!btn) throw new Error('ready-discard button not found');
          btn.click();
        });
        await sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.peerReady === true,
          null,
          { timeout: 15_000 }
        );

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathSingle]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 1, null, { timeout: 60_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 1, null, { timeout: 60_000 }),
        ]);

        console.log(`--- E2E (${label}) PASS: camera QR scan path transferred successfully ---`);
      } finally {
        try {
          await receiver.evaluate(() => {
            const s = window.__epheraFakeCamera;
            if (!s) return;
            try {
              if (s.media && typeof s.original === 'function') s.media.getUserMedia = s.original;
            } catch {}
            try {
              if (s.stream && typeof s.stream.getTracks === 'function') {
                const tracks = s.stream.getTracks();
                for (const t of tracks) {
                  try { t.stop(); } catch {}
                }
              }
            } catch {}
            try {
              if (s.raf) cancelAnimationFrame(s.raf);
            } catch {}
            try { delete window.__epheraFakeCamera; } catch {}
          });
        } catch {}
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runInviteQrCameraDeniedScenario({
      label = 'invite-qr-camera-denied',
      receiverExtraQuery = '',
    } = {}) {
      const ctx = await newContext();
      const page = await ctx.newPage();

      try {
        const normalizeExtraQuery = (value) => {
          const s = String(value || '').trim();
          if (!s) return '';
          return s.startsWith('&') ? s : `&${s}`;
        };
        const receiverExtraQ = normalizeExtraQuery(receiverExtraQuery);

        console.log(`--- E2E (${label}): launching page ---`);
        await page.goto(`${appBaseUrl}/index.html?e2e=1${receiverExtraQ}`, { waitUntil: 'domcontentloaded' });

        const cameraContract = await page.evaluate(() => {
          const s = window.__epheraE2E || {};
          const scanSupported = !!s.qrScanSupported;
          const hasMedia = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
          const btn = document.getElementById('start-qr-camera');
          return {
            scanSupported,
            hasMedia,
            startEnabled: !!(btn && !btn.disabled),
          };
        });

        if (!cameraContract.scanSupported || !cameraContract.hasMedia || !cameraContract.startEnabled) {
          console.log(`--- E2E (${label}): SKIP (unsupported-runtime) ---`);
          return;
        }

        console.log(`--- E2E (${label}): forcing getUserMedia denial ---`);
        await page.evaluate(() => {
          const media = navigator.mediaDevices;
          const original = media.getUserMedia.bind(media);
          media.getUserMedia = async () => {
            throw new Error('NotAllowedError');
          };
          window.__epheraFakeDeniedCamera = { media, original };
        });

        await page.evaluate(() => {
          const btn = document.getElementById('start-qr-camera');
          if (!btn) throw new Error('start-qr-camera button not found');
          btn.click();
        });

        await page.waitForFunction(
          () => {
            const s = window.__epheraE2E;
            return !!(s && s.qrLastScanSource === 'camera' && s.qrLastScanStatus === 'denied');
          },
          null,
          { timeout: 10_000 }
        );

        const deniedState = await page.evaluate(() => {
          const s = window.__epheraE2E || {};
          const preview = document.getElementById('qr-camera-preview');
          const stop = document.getElementById('stop-qr-camera');
          return {
            source: String(s.qrLastScanSource || ''),
            status: String(s.qrLastScanStatus || ''),
            signaling: String(s.signaling || ''),
            previewVisible: !!(preview && !preview.hidden),
            stopEnabled: !!(stop && !stop.disabled),
          };
        });

        if (deniedState.source !== 'camera' || deniedState.status !== 'denied') {
          throw new Error(`Expected camera denied state, got ${JSON.stringify(deniedState)}`);
        }
        if (deniedState.signaling === 'room-joined') {
          throw new Error('Camera denial path must not join room');
        }
        if (deniedState.previewVisible) {
          throw new Error('Camera preview must stay hidden when permission is denied');
        }
        if (deniedState.stopEnabled) {
          throw new Error('Stop camera button must stay disabled after permission denial');
        }

        console.log(`--- E2E (${label}) PASS: permission denial handled fail-safe ---`);
      } finally {
        try {
          await page.evaluate(() => {
            const s = window.__epheraFakeDeniedCamera;
            if (!s) return;
            try {
              if (s.media && typeof s.original === 'function') s.media.getUserMedia = s.original;
            } catch {}
            try { delete window.__epheraFakeDeniedCamera; } catch {}
          });
        } catch {}
        try { await ctx.close(); } catch {}
      }
    }

    async function runInvitePackageInvalidScenario() {
      const label = 'invite-package-invalid';
      const ctx = await newContext();
      const page = await ctx.newPage();

      try {
        console.log(`--- E2E (${label}): launching page ---`);
        await page.goto(`${appBaseUrl}/index.html?e2e=1`, { waitUntil: 'domcontentloaded' });

        console.log(`--- E2E (${label}): applying invalid package via apply+join ---`);
        await page.evaluate(() => {
          const input = document.getElementById('invite-package-input');
          const applyJoin = document.getElementById('apply-join-invite-package');
          if (!input) throw new Error('invite-package-input not found');
          if (!applyJoin) throw new Error('apply-join-invite-package button not found');
          input.value = [
            'Ephera Invite Package',
            'Room ID: invalid-room',
            'Room Auth Key: bad@key',
          ].join('\n');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          applyJoin.click();
        });

        await page.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.invitePackageParseState === 'invalid',
          null,
          { timeout: 10_000 }
        );

        const state = await page.evaluate(() => {
          const s = window.__epheraE2E || null;
          const status = (document.getElementById('status') || {}).textContent || '';
          const inviteState = (document.getElementById('invite-package-state') || {}).textContent || '';
          const disconnect = document.getElementById('disconnect');
          const join = document.getElementById('join-room');
          return {
            signaling: s ? s.signaling || null : null,
            status: String(status || ''),
            inviteState: String(inviteState || ''),
            disconnectDisabled: !!(disconnect && disconnect.disabled),
            joinDisabled: !!(join && join.disabled),
          };
        });

        const text = `${state.status} ${state.inviteState}`.toLowerCase();
        if (!text.includes('missing valid room auth key')) {
          throw new Error(`Expected invalid package reason in UI, got: ${JSON.stringify(state)}`);
        }
        if (state.signaling === 'room-joined' || state.signaling === 'room-created') {
          throw new Error(`Invalid package must not start signaling session, got signaling=${state.signaling}`);
        }
        if (state.disconnectDisabled !== true) {
          throw new Error('Invalid package must not enable disconnect/session state');
        }
        if (state.joinDisabled !== false) {
          throw new Error('Invalid package must not disable Join control');
        }

        console.log(`--- E2E (${label}) PASS: invalid invite package failed safely without join ---`);
      } finally {
        try { await ctx.close(); } catch {}
      }
    }

    async function runOwnerAuthorityScenario() {
      const label = 'owner-authority-ui';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${secretHash}`;

      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });

        await Promise.all([
          sender.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
            null,
            { timeout: 10_000 }
          ),
          receiver.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
            null,
            { timeout: 10_000 }
          ),
        ]);

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });

        console.log(`--- E2E (${label}): validating owner/peer role contract ---`);
        const readIdentity = async (page) => page.evaluate(() => {
          const s = window.__epheraE2E;
          if (!s) return null;
          return {
            peerId: s.peerId || null,
            roomOwnerPeerId: s.roomOwnerPeerId || null,
            localRole: s.localRole || null,
          };
        });

        const waitIdentityPair = async (timeoutMs) => {
          const startedAt = Date.now();
          let lastPair = null;
          while ((Date.now() - startedAt) < timeoutMs) {
            // eslint-disable-next-line no-await-in-loop
            const senderState = await readIdentity(sender);
            // eslint-disable-next-line no-await-in-loop
            const receiverState = await readIdentity(receiver);
            const senderOwner = !!(senderState && senderState.peerId && senderState.roomOwnerPeerId && senderState.peerId === senderState.roomOwnerPeerId);
            const receiverOwner = !!(receiverState && receiverState.peerId && receiverState.roomOwnerPeerId && receiverState.peerId === receiverState.roomOwnerPeerId);
            const hasBoth = !!(
              senderState && receiverState &&
              senderState.peerId && senderState.roomOwnerPeerId &&
              receiverState.peerId && receiverState.roomOwnerPeerId
            );
            lastPair = { senderState, receiverState, senderOwner, receiverOwner };
            if (hasBoth && (senderOwner !== receiverOwner)) {
              return lastPair;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(120);
          }
          throw new Error(`identity contract timeout (last=${JSON.stringify(lastPair)})`);
        };

        const identity = await waitIdentityPair(10_000);
        const ownerPage = identity.senderOwner ? sender : receiver;
        const peerPage = identity.senderOwner ? receiver : sender;

        const ownerControls = await ownerPage.evaluate(() => {
          const rotate = document.getElementById('rotate-room-key');
          const close = document.getElementById('close-room');
          return {
            rotateDisabled: !rotate || !!rotate.disabled,
            closeDisabled: !close || !!close.disabled,
          };
        });
        if (ownerControls.rotateDisabled || ownerControls.closeDisabled) {
          throw new Error(`Expected owner controls enabled on owner peer (identity=${JSON.stringify(identity)})`);
        }

        const peerControls = await peerPage.evaluate(() => {
          const rotate = document.getElementById('rotate-room-key');
          const close = document.getElementById('close-room');
          return {
            rotateDisabled: !rotate || !!rotate.disabled,
            closeDisabled: !close || !!close.disabled,
          };
        });
        if (!peerControls.rotateDisabled || !peerControls.closeDisabled) {
          throw new Error(`Expected owner controls disabled on non-owner peer (identity=${JSON.stringify(identity)})`);
        }

        const nextKey = generateRoomJoinKey(`${label}-next`);
        console.log(`--- E2E (${label}): rotating room auth key via owner control ---`);
        await ownerPage.evaluate((k) => {
          const keyInput = document.getElementById('room-join-key');
          const rotateBtn = document.getElementById('rotate-room-key');
          if (!keyInput) throw new Error('room-join-key input not found');
          if (!rotateBtn) throw new Error('rotate-room-key button not found');
          keyInput.value = k;
          keyInput.dispatchEvent(new Event('input', { bubbles: true }));
          rotateBtn.click();
        }, nextKey);

        await Promise.all([
          sender.waitForFunction((k) => {
            const input = document.getElementById('room-join-key');
            return !!(input && input.value === k);
          }, nextKey, { timeout: 10_000 }),
          receiver.waitForFunction((k) => {
            const input = document.getElementById('room-join-key');
            return !!(input && input.value === k);
          }, nextKey, { timeout: 10_000 }),
        ]);

        console.log(`--- E2E (${label}): closing room via owner control ---`);
        await ownerPage.evaluate(() => {
          const closeBtn = document.getElementById('close-room');
          if (!closeBtn) throw new Error('close-room button not found');
          closeBtn.click();
        });

        await Promise.all([
          sender.waitForFunction(() => {
            const dis = document.getElementById('disconnect');
            const create = document.getElementById('create-room');
            const status = (document.getElementById('status') || {}).textContent || '';
            return !!(dis && create && dis.disabled === true && create.disabled === false && status.includes('Room closed by owner'));
          }, null, { timeout: 12_000 }),
          receiver.waitForFunction(() => {
            const dis = document.getElementById('disconnect');
            const create = document.getElementById('create-room');
            const status = (document.getElementById('status') || {}).textContent || '';
            return !!(dis && create && dis.disabled === true && create.disabled === false && status.includes('Room closed by owner'));
          }, null, { timeout: 12_000 }),
        ]);

        console.log(`--- E2E (${label}) PASS: owner controls enforced + rotate/close flow succeeded ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    async function runOwnerDisconnectTransferScenario() {
      const label = 'owner-disconnect-transfer-ui';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

      const ownerUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
      const peerUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${secretHash}`;

      const ownerCtx = await newContext();
      const peerCtx = await newContext();
      const owner = await ownerCtx.newPage();
      const peer = await peerCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await owner.goto(ownerUrl, { waitUntil: 'domcontentloaded' });
        await peer.goto(peerUrl, { waitUntil: 'domcontentloaded' });

        await Promise.all([
          owner.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
            null,
            { timeout: 10_000 }
          ),
          peer.waitForFunction(
            () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
            null,
            { timeout: 10_000 }
          ),
        ]);

        console.log(`--- E2E (${label}): waiting for initial role contract ---`);
        await Promise.all([
          owner.waitForFunction(() => {
            const s = window.__epheraE2E;
            if (!s) return false;
            return !!(
              s.localRole === 'owner' &&
              s.peerId &&
              s.roomOwnerPeerId &&
              s.peerId === s.roomOwnerPeerId
            );
          }, null, { timeout: 10_000 }),
          peer.waitForFunction(() => {
            const s = window.__epheraE2E;
            if (!s) return false;
            return !!(
              s.localRole === 'peer' &&
              s.peerId &&
              s.roomOwnerPeerId &&
              s.peerId !== s.roomOwnerPeerId
            );
          }, null, { timeout: 10_000 }),
        ]);

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          owner.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          peer.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        const preTransferControls = await peer.evaluate(() => {
          const rotate = document.getElementById('rotate-room-key');
          const close = document.getElementById('close-room');
          return {
            rotateDisabled: !rotate || !!rotate.disabled,
            closeDisabled: !close || !!close.disabled,
          };
        });
        if (!preTransferControls.rotateDisabled || !preTransferControls.closeDisabled) {
          throw new Error(`Expected non-owner controls to be disabled before owner disconnect (${JSON.stringify(preTransferControls)})`);
        }

        console.log(`--- E2E (${label}): closing owner signaling to force ownership transfer ---`);
        await owner.evaluate(() => {
          const e = window.__epheraE2E;
          if (!e || typeof e.closeSignaling !== 'function') {
            throw new Error('e2e closeSignaling hook not available');
          }
          e.closeSignaling();
        });

        await peer.waitForFunction(() => {
          const s = window.__epheraE2E;
          const rotate = document.getElementById('rotate-room-key');
          const close = document.getElementById('close-room');
          if (!s) return false;
          const nowOwner = !!(
            s.localRole === 'owner' &&
              s.peerId &&
              s.roomOwnerPeerId &&
              s.peerId === s.roomOwnerPeerId
          );
          const controlsEnabled = !!(rotate && close && !rotate.disabled && !close.disabled);
          return nowOwner && controlsEnabled;
        }, null, { timeout: 20_000 });

        console.log(`--- E2E (${label}): rotating room key as transferred owner ---`);
        const nextJoinKey = generateRoomJoinKey(`${label}-rotated`);
        const rotatedBaseline = await peer.evaluate(() => {
          const s = window.__epheraE2E;
          return s ? (s.roomKeyRotatedCount || 0) : 0;
        });

        await peer.evaluate((k) => {
          const keyInput = document.getElementById('room-join-key');
          const rotateBtn = document.getElementById('rotate-room-key');
          if (!keyInput) throw new Error('room-join-key input not found');
          if (!rotateBtn) throw new Error('rotate-room-key button not found');
          keyInput.value = k;
          keyInput.dispatchEvent(new Event('input', { bubbles: true }));
          rotateBtn.click();
        }, nextJoinKey);

        await peer.waitForFunction(({ k, baseline }) => {
          const s = window.__epheraE2E;
          const keyInput = document.getElementById('room-join-key');
          if (!s || !keyInput) return false;
          return (
            keyInput.value === k &&
            (s.roomKeyRotatedCount || 0) > baseline
          );
        }, { k: nextJoinKey, baseline: rotatedBaseline }, { timeout: 10_000 });

        console.log(`--- E2E (${label}): validating old key denied / rotated key accepted ---`);
        const lateJoinerCtx = await newContext();
        const lateJoiner = await lateJoinerCtx.newPage();
        try {
          const staleHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;
          const staleUrl = `${appBaseUrl}/index.html?e2e=1&role=join&roomId=${encodeURIComponent(roomId)}${staleHash}`;
          await lateJoiner.goto(staleUrl, { waitUntil: 'domcontentloaded' });

          await lateJoiner.waitForFunction(() => {
            const status = (document.getElementById('status') || {}).textContent || '';
            return status.includes('Join unavailable');
          }, null, { timeout: 12_000 });

          await lateJoiner.evaluate((k) => {
            const keyInput = document.getElementById('room-join-key');
            const joinBtn = document.getElementById('join-room');
            if (!keyInput) throw new Error('room-join-key input not found');
            if (!joinBtn) throw new Error('join-room button not found');
            keyInput.value = k;
            keyInput.dispatchEvent(new Event('input', { bubbles: true }));
            joinBtn.click();
          }, nextJoinKey);

          await lateJoiner.waitForFunction(() => {
            const s = window.__epheraE2E;
            return !!(s && s.signaling === 'room-joined');
          }, null, { timeout: 12_000 });
        } finally {
          try { await lateJoinerCtx.close(); } catch {}
        }

        console.log(`--- E2E (${label}) PASS: ownership transferred on disconnect and owner controls remained correct ---`);
      } finally {
	        try { await ownerCtx.close(); } catch {}
	        try { await peerCtx.close(); } catch {}
	      }
	    }

	    async function installFakeFolderPicker(page) {
	      await page.evaluate(() => {
	        const files = Object.create(null); // relative path -> { chunks, size, data, sum, first16, last16 }

	        function normalizeChunk(v) {
	          if (v instanceof Uint8Array) return v;
	          if (v instanceof ArrayBuffer) return new Uint8Array(v);
	          if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	          throw new Error('unsupported writable chunk type');
	        }

	        function computeDigest(u8) {
	          const size = u8.byteLength >>> 0;
	          let sum = 0;
	          for (let i = 0; i < u8.byteLength; i++) sum = (sum + u8[i]) >>> 0;
	          const first16 = Array.from(u8.slice(0, 16));
	          const last16 = Array.from(u8.slice(Math.max(0, u8.byteLength - 16)));
	          return { size, sum, first16, last16 };
	        }

	        function joinPath(prefix, name) {
	          const safeName = String(name || '').trim();
	          if (!safeName) throw new Error('Invalid path segment');
	          return prefix ? `${prefix}/${safeName}` : safeName;
	        }

	        function createDirHandle(prefix = '') {
	          return {
	            name: prefix ? prefix.split('/').slice(-1)[0] : 'ephera-e2e',
	            async requestPermission() { return 'granted'; },
	            async getDirectoryHandle(name) {
	              return createDirHandle(joinPath(prefix, name));
	            },
	            async getFileHandle(name, opts) {
	              const key = joinPath(prefix, name);
	              const create = !!(opts && opts.create);
	              if (!files[key]) {
	                if (!create) {
	                  const err = new Error('NotFoundError');
	                  err.name = 'NotFoundError';
	                  throw err;
	                }
	                files[key] = { chunks: [], size: 0, data: null, sum: 0, first16: [], last16: [] };
	              }
	              const entry = files[key];
	              return {
	                async createWritable() {
	                  entry.chunks = [];
	                  entry.size = 0;
	                  entry.data = null;
	                  entry.sum = 0;
	                  entry.first16 = [];
	                  entry.last16 = [];

	                  let aborted = false;
	                  let closed = false;

	                  return {
	                    async write(v) {
	                      if (aborted) throw new Error('writable aborted');
	                      if (closed) throw new Error('writable closed');
	                      const u8 = normalizeChunk(v);
	                      const copy = new Uint8Array(u8.byteLength);
	                      copy.set(u8);
	                      entry.chunks.push(copy);
	                      entry.size += copy.byteLength;
	                    },
	                    async close() {
	                      if (aborted) throw new Error('writable aborted');
	                      if (closed) return;
	                      closed = true;

	                      const out = new Uint8Array(entry.size);
	                      let off = 0;
	                      for (const c of entry.chunks) {
	                        out.set(c, off);
	                        off += c.byteLength;
	                      }
	                      entry.data = out;
	                      const d = computeDigest(out);
	                      entry.size = d.size >>> 0;
	                      entry.sum = d.sum >>> 0;
	                      entry.first16 = d.first16;
	                      entry.last16 = d.last16;
	                    },
	                    abort() { aborted = true; },
	                  };
	                },
	              };
	            },
	          };
	        }

	        window.__epheraFakeFs = {
	          list() { return Object.keys(files).sort(); },
	          digest(name) {
	            const e = files[name];
	            if (!e || !e.data) return null;
	            return { name, size: e.size >>> 0, sum: e.sum >>> 0, first16: e.first16, last16: e.last16 };
	          },
	        };

	        window.showDirectoryPicker = async () => createDirHandle('');
	      });

	      await page.evaluate(() => {
	        const s = window.__epheraE2E;
	        if (s && typeof s.refreshPreflight === 'function') s.refreshPreflight();
	      });

	      await page.waitForFunction(() => {
	        const s = window.__epheraE2E;
	        const btn = document.getElementById('pick-receive-folder');
	        if (!s || !btn) return false;
	        return s.preflightFolderSaveCapable === true && btn.disabled === false;
	      }, null, { timeout: 10_000 });
	    }

	    async function runFolderSavePolyfillScenario() {
      const label = 'folder-save-polyfill';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const roomJoinKey = generateRoomJoinKey(label);
      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
      // Disable autoReady so the "ready" event is produced only by the folder picker path.
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&roomId=${encodeURIComponent(roomId)}${secretHash}`;

      const senderCtx = await newContext();
      const receiverCtx = await newContext();
      const sender = await senderCtx.newPage();
      const receiver = await receiverCtx.newPage();

      try {
        console.log(`--- E2E (${label}): launching pages ---`);
        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });

        console.log(`--- E2E (${label}): waiting for WebRTC transport open ---`);
        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
        ]);

        console.log(`--- E2E (${label}): syncing auto-generated passphrase ---`);
        const senderPass = await sender.evaluate(() => (document.getElementById('passphrase') || {}).value || '');
        if (!senderPass) throw new Error('Expected sender passphrase to be populated');

        await receiver.evaluate((p) => {
          const input = document.getElementById('passphrase');
          if (!input) throw new Error('passphrase input not found');
          input.value = p;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, senderPass);

	        console.log(`--- E2E (${label}): installing in-memory folder picker polyfill ---`);
	        await installFakeFolderPicker(receiver);

        console.log(`--- E2E (${label}): picking receive folder (polyfilled) ---`);
        await receiver.evaluate(() => {
          const btn = document.getElementById('pick-receive-folder');
          if (!btn) throw new Error('pick-receive-folder button not found');
          btn.click();
        });

        // Wait for sender to observe receiver readiness (requires signaling).
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 15_000 });
        await receiver.waitForFunction(() => {
          const s = window.__epheraE2E;
          if (!s) return false;
          const modeOk = s.receiveDestinationMode === 'saved';
          const label = String(s.receiveDestinationLabel || '').toLowerCase();
          return modeOk && label.includes('save to folder');
        }, null, { timeout: 15_000 });

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', [filePathSingle]);
        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
        await sender.evaluate(() => document.getElementById('send-file').click());

        await Promise.all([
          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 1, null, { timeout: 60_000 }),
          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 1, null, { timeout: 60_000 }),
        ]);

        console.log(`--- E2E (${label}): waiting for saved delivery receipt ---`);
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.deliveredSavedCount >= 1, null, { timeout: 15_000 });

        const digest = await receiver.evaluate(() => {
          const fs = window.__epheraFakeFs;
          if (!fs || typeof fs.list !== 'function' || typeof fs.digest !== 'function') return null;
          const names = fs.list();
          if (!Array.isArray(names) || names.length !== 1) return { names };
          return fs.digest(names[0]);
        });

        if (!digest) throw new Error('Expected fake FS digest to be available');
        if (!digest.name || typeof digest.size !== 'number') throw new Error(`Bad fake FS digest: ${JSON.stringify(digest)}`);
        if (digest.name !== 'e2e.bin') throw new Error(`Expected saved name e2e.bin, got ${digest.name}`);
        if (digest.size !== fileSize) throw new Error(`Saved size mismatch: expected ${fileSize}, got ${digest.size}`);
        if (digest.sum !== 66846720) throw new Error(`Saved checksum mismatch: expected 66846720, got ${digest.sum}`);
        if (JSON.stringify(digest.first16) !== JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])) {
          throw new Error(`Saved first16 mismatch: ${JSON.stringify(digest.first16)}`);
        }
        if (JSON.stringify(digest.last16) !== JSON.stringify([240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255])) {
          throw new Error(`Saved last16 mismatch: ${JSON.stringify(digest.last16)}`);
        }

        const receiverState = await receiver.evaluate(() => window.__epheraE2E);
        if (!receiverState) throw new Error('Missing receiver __epheraE2E state');
        if (receiverState.receiveDestinationMode !== 'saved') {
          throw new Error(`Expected saved destination mode, got ${receiverState.receiveDestinationMode}`);
        }
        const inboundOutcome = String(receiverState.lastInboundOutcome || '').toLowerCase();
        if (!inboundOutcome.includes('saved -> ephera-e2e/e2e.bin')) {
          throw new Error(`Expected saved inbound outcome, got ${JSON.stringify(receiverState.lastInboundOutcome)}`);
        }

	        console.log(`--- E2E (${label}) PASS: saved receipt + saved bytes verified (polyfill) ---`);
	      } finally {
	        try { await senderCtx.close(); } catch {}
	        try { await receiverCtx.close(); } catch {}
	      }
	    }

	    async function runFolderSendPolyfillScenario() {
	      const label = 'folder-send-polyfill';
	      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
	      const roomJoinKey = generateRoomJoinKey(label);
	      const secretHash = `#roomJoinKey=${encodeURIComponent(roomJoinKey)}`;

	      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${secretHash}`;
	      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&roomId=${encodeURIComponent(roomId)}${secretHash}`;

	      const senderCtx = await newContext();
	      const receiverCtx = await newContext();
	      const sender = await senderCtx.newPage();
	      const receiver = await receiverCtx.newPage();

	      try {
	        console.log(`--- E2E (${label}): launching pages ---`);
	        await sender.goto(senderUrl, { waitUntil: 'domcontentloaded' });
	        await receiver.goto(receiverUrl, { waitUntil: 'domcontentloaded' });

	        await Promise.all([
	          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
	          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.transportOpen === true, null, { timeout: 20_000 }),
	        ]);

	        console.log(`--- E2E (${label}): syncing auto-generated passphrase ---`);
	        const senderPass = await sender.evaluate(() => (document.getElementById('passphrase') || {}).value || '');
	        if (!senderPass) throw new Error('Expected sender passphrase to be populated');

	        await receiver.evaluate((p) => {
	          const input = document.getElementById('passphrase');
	          if (!input) throw new Error('passphrase input not found');
	          input.value = p;
	          input.dispatchEvent(new Event('input', { bubbles: true }));
	        }, senderPass);

	        console.log(`--- E2E (${label}): installing nested fake folder picker ---`);
	        await installFakeFolderPicker(receiver);

	        await receiver.evaluate(() => {
	          const btn = document.getElementById('pick-receive-folder');
	          if (!btn) throw new Error('pick-receive-folder button not found');
	          btn.click();
	        });

	        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 15_000 });

	        console.log(`--- E2E (${label}): selecting sender folder + sending ---`);
	        await sender.setInputFiles('#folder-input', folderBatchRoot);
	        await sender.waitForFunction(() => !document.getElementById('send-file').disabled, null, { timeout: 20_000 });
	        await sender.evaluate(() => document.getElementById('send-file').click());

	        await Promise.all([
	          sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 2, null, { timeout: 60_000 }),
	          receiver.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 2, null, { timeout: 60_000 }),
	        ]);

	        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.deliveredSavedCount >= 2, null, { timeout: 20_000 });

	        const fsState = await receiver.evaluate(() => {
	          const fs = window.__epheraFakeFs;
	          if (!fs || typeof fs.list !== 'function' || typeof fs.digest !== 'function') return null;
	          const names = fs.list();
	          return {
	            names,
	            docs: fs.digest('payload-folder/docs/guide.bin'),
	            media: fs.digest('payload-folder/media/clip.bin'),
	          };
	        });

	        if (!fsState || !Array.isArray(fsState.names)) {
	          throw new Error(`Expected fake FS state, got ${JSON.stringify(fsState)}`);
	        }

	        for (const expected of [folderBatchRelA, folderBatchRelB]) {
	          if (!fsState.names.includes(expected)) {
	            throw new Error(`Saved folder listing missing ${expected}: ${JSON.stringify(fsState.names)}`);
	          }
	        }

	        const docs = fsState.docs;
	        const media = fsState.media;
	        if (!docs || docs.name !== folderBatchRelA) throw new Error(`Bad docs digest: ${JSON.stringify(docs)}`);
	        if (!media || media.name !== folderBatchRelB) throw new Error(`Bad media digest: ${JSON.stringify(media)}`);

	        for (const [actual, expected, labelPart] of [
	          [docs, folderBatchDigestA, 'docs'],
	          [media, folderBatchDigestB, 'media'],
	        ]) {
	          if (actual.size !== expected.size) throw new Error(`${labelPart} size mismatch: expected ${expected.size}, got ${actual.size}`);
	          if (actual.sum !== expected.sum) throw new Error(`${labelPart} checksum mismatch: expected ${expected.sum}, got ${actual.sum}`);
	          if (JSON.stringify(actual.first16) !== JSON.stringify(expected.first16)) {
	            throw new Error(`${labelPart} first16 mismatch: ${JSON.stringify(actual.first16)}`);
	          }
	          if (JSON.stringify(actual.last16) !== JSON.stringify(expected.last16)) {
	            throw new Error(`${labelPart} last16 mismatch: ${JSON.stringify(actual.last16)}`);
	          }
	        }

	        const receiverState = await receiver.evaluate(() => window.__epheraE2E);
	        if (!receiverState) throw new Error('Missing receiver __epheraE2E state');
	        const recvTitles = Array.isArray(receiverState.recvTitles) ? receiverState.recvTitles : [];
	        for (const expected of [folderBatchRelA, folderBatchRelB]) {
	          if (!recvTitles.includes(expected)) {
	            throw new Error(`Expected recvTitles to include ${expected}, got ${JSON.stringify(recvTitles)}`);
	          }
	        }

	        console.log(`--- E2E (${label}) PASS: folder hierarchy preserved across sender metadata + receiver save path ---`);
	      } finally {
	        try { await senderCtx.close(); } catch {}
	        try { await receiverCtx.close(); } catch {}
	      }
	    }

    async function runFolderInputFallbackScenario() {
      const label = 'folder-input-fallback';
      await runScenario({
        label,
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        senderExtraQuery: 'noFolderUpload=1',
        selectionMode: 'folder-input',
        folderInputPath: folderBatchRoot,
        files: [
          {
            name: 'guide.bin',
            mimeType: 'application/octet-stream',
            buffer: fileBuf,
          },
          {
            name: 'clip.bin',
            mimeType: 'application/octet-stream',
            buffer: fileBuf2,
          },
        ],
        expectSenderFolderUploadCapable: false,
        expectSelectionSummaryIncludes: 'payload batch selected',
        expectSelectionSummaryExcludes: 'folder batch selected',
        expectReceipt: true,
      });
      console.log(`--- E2E (${label}) PASS: unsupported folder runtime downgraded to file payload mode ---`);
    }

    async function runLedgerClearActiveScenario() {
      const label = 'ledger-clear-active';
      await runScenario({
        label,
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [filePathCrash],
        transferTimeoutMs: 120_000,
        expectReceipt: true,
        onSendStarted: async ({ sender, readTransferLedgerSnapshot: readLedger }) => {
          await sender.waitForFunction(() => {
            const el = document.getElementById('transfer-ledger-active-count');
            const text = el ? String(el.textContent || '') : '';
            const m = text.match(/(\d+)/);
            return !!(m && Number(m[1]) > 0);
          }, null, { timeout: 20_000 });

          await sender.evaluate(() => {
            const btn = document.getElementById('clear-transfer-ledger');
            if (!btn) throw new Error('clear-transfer-ledger button not found');
            btn.click();
          });

          const snapshot = await readLedger(sender);
          if (!snapshot || snapshot.count < 1 || snapshot.active < 1) {
            throw new Error(`Active ledger entry disappeared after clear: ${JSON.stringify(snapshot)}`);
          }
        },
      });
      console.log(`--- E2E (${label}) PASS: clear action preserved active in-flight ledger entries ---`);
    }

    async function runLedgerOverflowRetentionScenario() {
      const label = 'ledger-overflow-active-retention';
      const overflowFiles = [];
      for (let i = 0; i < 48; i++) {
        overflowFiles.push({
          name: `overflow-${i}.bin`,
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(512 * 1024, i & 0xff),
        });
      }

      await runScenario({
        label,
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: overflowFiles,
        recvDelayMs: 10,
        transferTimeoutMs: 120_000,
        expectReceipt: true,
        onSendStarted: async ({ receiver, readTransferLedgerSnapshot: readLedger }) => {
          await receiver.waitForFunction(() => {
            const parse = (id) => {
              const el = document.getElementById(id);
              const txt = el ? String(el.textContent || '') : '';
              const m = txt.match(/(\d+)/);
              return m ? Number(m[1]) : 0;
            };
            const cards = document.querySelectorAll('#transfer-ledger-list .ledger-entry').length;
            const active = parse('transfer-ledger-active-count');
            const s = window.__epheraE2E;
            const recvDone = s ? Number(s.recvDoneCount || 0) : 0;
            return recvDone >= 41 && recvDone < 48 && cards >= 40 && active > 0;
          }, null, { timeout: 90_000 });

          const snapshot = await readLedger(receiver);
          if (!snapshot || snapshot.count < 40) {
            throw new Error(`Receiver ledger did not retain active overflow entries: ${JSON.stringify(snapshot)}`);
          }
        },
      });
      console.log(`--- E2E (${label}) PASS: active inbound entries were retained beyond settled cap during overflow ---`);
    }

    if (REMOTE_MODE && FAST) {
      console.log('--- E2E MODE: FAST REMOTE (deployed subset) ---');
      await runScenario({
        label: 'remote-fast-core',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-fast-plain',
        passphrase: null,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-fast-drop-send-bay',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [filePathB],
        selectionMode: 'drop',
        expectReceipt: true,
      });
      await runFolderInputFallbackScenario();
      await runInvitePackageApplyScenario();
      await runInviteQrPairingScenario({
        label: 'remote-fast-invite-qr-pairing-jsqr',
        receiverExtraQuery: 'qrScanMode=jsqr',
        expectedEngine: 'jsqr',
      });
      await runInvitePackageInvalidScenario();
      return;
    }

    if (FAST) {
      console.log('--- E2E MODE: FAST (smoke subset) ---');
      await runScenario({
        label: 'fast-same-origin',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        expectReceipt: true,
      });
      await runScenario({
        label: 'fast-plain',
        passphrase: null,
        expectReceipt: true,
      });
      await runScenario({
        label: 'fast-app-server',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'fast-drop-send-bay',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        files: [filePathB],
        selectionMode: 'drop',
        expectReceipt: true,
      });
      await runFolderInputFallbackScenario();
      await runInvitePackageApplyScenario();
      await runInviteQrPairingScenario({
        label: 'fast-invite-qr-pairing-jsqr',
        receiverExtraQuery: 'qrScanMode=jsqr',
        expectedEngine: 'jsqr',
      });
      await runInviteQrCameraDeniedScenario({
        receiverExtraQuery: 'qrScanMode=jsqr',
      });
      await runInvitePackageInvalidScenario();
      return;
    }

    if (REMOTE_MODE) {
      console.log('--- E2E MODE: REMOTE FULL (deployed-compatible subset) ---');
      await runScenario({
        label: 'remote-core',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-passphrase-mismatch',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        mismatchPassphrase: true,
        expectSendDisabled: true,
      });
      await runScenario({
        label: 'remote-protocol-mismatch',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectSendDisabled: true,
        expectDisabledReason: 'protocol version mismatch',
        skipPeerReadyWait: true,
        senderExtraQuery: 'protoVersion=3&protoMin=3',
        receiverExtraQuery: 'protoVersion=1&protoMin=1',
      });
      await runScenario({
        label: 'remote-plain',
        passphrase: null,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-multi-plain',
        passphrase: null,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [filePathA, filePathB],
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-drop-send-bay',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [filePathB],
        selectionMode: 'drop',
        expectReceipt: true,
      });
      await runFolderInputFallbackScenario();
      await runScenario({
        label: 'remote-passphrase',
        passphrase: 'e2e-passphrase',
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        expectReceipt: true,
      });
      await runScenario({
        label: 'remote-peer-left',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        closeReceiverSignaling: true,
        expectReceipt: true,
      });
      console.log('--- E2E (signaling-restart): SKIP (remote mode requires local signaling process) ---');
      console.log('--- E2E (signaling-crash): SKIP (remote mode requires local signaling process) ---');
      console.log('--- E2E (secure-app-server): SKIP (remote mode already targets deployed HTTPS runtime) ---');
      console.log('--- E2E (relay-runtime-config): SKIP (relay runtime validation is local-only) ---');

      const gcFiles = [];
      for (let i = 0; i < 16; i++) {
        gcFiles.push({
          name: `gc-${i}.bin`,
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(64 * 1024, i & 0xff),
        });
      }

      await runJoinLinkAutojoinScenario();
      await runInvitePackageApplyScenario();
      await runInviteQrPairingScenario();
      await runInviteQrPairingScenario({
        label: 'remote-invite-qr-pairing-jsqr',
        receiverExtraQuery: 'qrScanMode=jsqr',
        expectedEngine: 'jsqr',
      });
      await runInviteQrCameraScanScenario({
        receiverExtraQuery: 'qrScanMode=jsqr',
        expectedEngine: 'jsqr',
      });
      await runInviteQrCameraDeniedScenario({
        receiverExtraQuery: 'qrScanMode=jsqr',
      });
      await runInviteQrInvalidImageScenario({
        receiverExtraQuery: 'qrScanMode=jsqr',
      });
      await runInvitePackageInvalidScenario();
      await runOwnerAuthorityScenario();
      await runOwnerDisconnectTransferScenario();
      await runFolderSavePolyfillScenario();
      await runFolderSendPolyfillScenario();
      await runLedgerClearActiveScenario();
      await runLedgerOverflowRetentionScenario();

      await runScenario({
        label: 'remote-gc-sessions',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: gcFiles,
        checkGc: true,
      });

      await runSenderCloseMidTransferScenario();
      await runReceiverCancelMidTransferScenario();
      await runConnectDisconnectCyclesScenario({ cycles: 5 });

      if (PERF) {
        await runScenario({
          label: 'remote-perf-100mb',
          passphrase: null,
          expectAutoPassphrase: true,
          sameOrigin: true,
          baseUrlOverride: appBaseUrl,
          files: [filePathPerfLarge],
          recvDelayMs: 0,
          transferTimeoutMs: 180_000,
          expectReceipt: true,
          perf: {
            enabled: true,
            pollMs: 100,
            maxBufferedAmountBytes: 8 * 1024 * 1024,
            maxHeapGrowthBytes: 64 * 1024 * 1024,
            postGcHeapSlackBytes: 16 * 1024 * 1024,
          },
        });
      }

      if (SOAK) {
        const idleFile = {
          name: 'idle.bin',
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(10 * 1024 * 1024, 0x11),
        };

        await runScenario({
          label: `remote-idle-${SOAK_IDLE_MS}ms`,
          passphrase: null,
          expectAutoPassphrase: true,
          sameOrigin: true,
          baseUrlOverride: appBaseUrl,
          files: [idleFile],
          idleMsBeforeSend: SOAK_IDLE_MS,
          transferTimeoutMs: 180_000,
          expectReceipt: true,
        });

        await runConnectDisconnectCyclesScenario({ cycles: SOAK_CYCLES });
      }

      return;
    }

    await runScenario({ label: 'same-origin', passphrase: null, expectAutoPassphrase: true, sameOrigin: true, expectReceipt: true });
    await runScenario({ label: 'default-secure', passphrase: null, expectAutoPassphrase: true, expectReceipt: true });
    await runScenario({ label: 'passphrase-mismatch', passphrase: null, expectAutoPassphrase: true, mismatchPassphrase: true, expectSendDisabled: true });
    await runScenario({
      label: 'protocol-mismatch',
      passphrase: null,
      expectAutoPassphrase: true,
      expectSendDisabled: true,
      expectDisabledReason: 'protocol version mismatch',
      skipPeerReadyWait: true,
      senderExtraQuery: 'protoVersion=3&protoMin=3',
      receiverExtraQuery: 'protoVersion=1&protoMin=1',
    });
    await runScenario({ label: 'plain', passphrase: null, expectReceipt: true });
    await runScenario({
      label: 'multi-plain',
      passphrase: null,
      files: [filePathA, filePathB],
      expectReceipt: true,
    });
    await runScenario({
      label: 'drop-send-bay',
      passphrase: null,
      expectAutoPassphrase: true,
      sameOrigin: true,
      files: [filePathB],
      selectionMode: 'drop',
      expectReceipt: true,
    });
    await runFolderInputFallbackScenario();
    await runScenario({ label: 'passphrase', passphrase: 'e2e-passphrase', expectReceipt: true });
    await runScenario({
      label: 'peer-left',
      passphrase: null,
      expectAutoPassphrase: true,
      closeReceiverSignaling: true,
      expectReceipt: true,
    });
    await runScenario({
      label: 'signaling-restart',
      passphrase: null,
      expectAutoPassphrase: true,
      restartSignaling: true,
      expectReceipt: true,
    });
    await runScenario({
      label: 'signaling-crash',
      passphrase: null,
      expectAutoPassphrase: true,
      files: [filePathCrash],
      killSignaling: true,
      expectReceipt: true,
    });

    // Validate "npm start" deployment path (server/serve.js): same-origin static + WS + CSP headers.
    await runScenario({
      label: 'app-server',
      passphrase: null,
      expectAutoPassphrase: true,
      sameOrigin: true,
      baseUrlOverride: appBaseUrl,
      expectReceipt: true,
    });

    // Validate secure HTTPS+WSS runtime path (dev-secure.js) with self-signed cert.
    await runScenario({
      label: 'secure-app-server',
      passphrase: null,
      expectAutoPassphrase: true,
      sameOrigin: true,
      baseUrlOverride: secureBaseUrl,
      expectReceipt: true,
      contextOptions: { ignoreHTTPSErrors: true },
    });

    let relayScenarioRan = false;
    if (RELAY_RUNTIME) {
      await runScenario({
        label: 'relay-runtime-config',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: relayAppBaseUrl,
        expectReceipt: true,
        transferTimeoutMs: 120_000,
        expectRelayPolicy: true,
      });
      relayScenarioRan = true;
    } else {
      console.log('--- E2E (relay-runtime-config): SKIP (run `npm run e2e:relay` or `npm run e2e:relay:required`) ---');
    }

    if (RELAY_REQUIRED && !relayScenarioRan) {
      throw new Error('Relay runtime scenario is required but did not execute.');
    }

    // Automated leak gate: force GC and assert TransferSession objects are collectible.
    // This catches obvious reference leaks without requiring a manual heap snapshot.
    const gcFiles = [];
    for (let i = 0; i < 16; i++) {
      gcFiles.push({
        name: `gc-${i}.bin`,
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(64 * 1024, i & 0xff),
      });
    }

    await runJoinLinkAutojoinScenario();
    await runInvitePackageApplyScenario();
    await runInviteQrPairingScenario();
    await runInviteQrPairingScenario({
      label: 'invite-qr-pairing-jsqr',
      receiverExtraQuery: 'qrScanMode=jsqr',
      expectedEngine: 'jsqr',
    });
    await runInviteQrCameraScanScenario({
      receiverExtraQuery: 'qrScanMode=jsqr',
      expectedEngine: 'jsqr',
    });
    await runInviteQrCameraDeniedScenario({
      receiverExtraQuery: 'qrScanMode=jsqr',
    });
    await runInviteQrInvalidImageScenario({
      receiverExtraQuery: 'qrScanMode=jsqr',
    });
	    await runInvitePackageInvalidScenario();
	    await runOwnerAuthorityScenario();
	    await runOwnerDisconnectTransferScenario();
	    await runFolderSavePolyfillScenario();
	    await runFolderSendPolyfillScenario();
    await runLedgerClearActiveScenario();
    await runLedgerOverflowRetentionScenario();

    await runScenario({
      label: 'gc-sessions',
      passphrase: null,
      expectAutoPassphrase: true,
      sameOrigin: true,
      baseUrlOverride: appBaseUrl,
      files: gcFiles,
      checkGc: true,
    });

    // Failure gate: sender tab close mid-transfer should abort receiver deterministically.
    await runSenderCloseMidTransferScenario();

    // Failure gate: receiver cancel should abort sender deterministically (peer ABORT propagation).
    await runReceiverCancelMidTransferScenario();

    // Stability gate: repeated connect/disconnect cycles without reload.
    await runConnectDisconnectCyclesScenario({ cycles: 5 });

    if (PERF) {
      // Perf hardening gate (automated approximation of manual checklist):
      // - large file (100MB) transfer
      // - slow consumer simulation on receiver (small delay, should not accumulate unbounded memory)
      // - bounded sender bufferedAmount (backpressure)
      await runScenario({
        label: 'perf-100mb',
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [filePathPerfLarge],
        recvDelayMs: 0,
        transferTimeoutMs: 180_000,
        expectReceipt: true,
        perf: {
          enabled: true,
          pollMs: 100,
          // Transport high watermark is 4MB; allow some slack.
          maxBufferedAmountBytes: 8 * 1024 * 1024,
          // Heap growth should not scale with file size; allow generous headroom for Chromium variance.
          maxHeapGrowthBytes: 64 * 1024 * 1024,
          // After forced GC post-transfer, heap should return close to baseline.
          postGcHeapSlackBytes: 16 * 1024 * 1024,
        },
      });
    }

    if (SOAK) {
      // Soak / long-session approximations (optional, slower).
      // - Longer idle with established P2P
      // - More connect/disconnect cycles
      const idleFile = {
        name: 'idle.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(10 * 1024 * 1024, 0x11), // 10MB
      };

      await runScenario({
        label: `idle-${SOAK_IDLE_MS}ms`,
        passphrase: null,
        expectAutoPassphrase: true,
        sameOrigin: true,
        baseUrlOverride: appBaseUrl,
        files: [idleFile],
        idleMsBeforeSend: SOAK_IDLE_MS,
        transferTimeoutMs: 180_000,
        expectReceipt: true,
      });

      await runConnectDisconnectCyclesScenario({ cycles: SOAK_CYCLES });
    }
  } finally {
    try { await browser.close(); } catch {}

    try { if (sameOriginSignaling) await sameOriginSignaling.close(); } catch {}
    try { if (staticServer) staticServer.server.close(); } catch {}
    try { if (signaling) signaling.proc.kill('SIGINT'); } catch {}
    try { if (appServer) appServer.proc.kill('SIGINT'); } catch {}
    try { if (relayAppServer) relayAppServer.proc.kill('SIGINT'); } catch {}
    try { if (secureServer) secureServer.proc.kill('SIGINT'); } catch {}

    // Best-effort temp cleanup
    try { fs.unlinkSync(filePathSingle); } catch {}
	    try { fs.unlinkSync(filePathA); } catch {}
	    try { fs.unlinkSync(filePathB); } catch {}
	    try { fs.unlinkSync(filePathCrash); } catch {}
	    try { fs.unlinkSync(filePathPerfLarge); } catch {}
	    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	  }
	}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
