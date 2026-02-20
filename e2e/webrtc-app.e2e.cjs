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

  const staticServer = await startStaticServer();
  const sameOriginSignaling = createSignalingServer({ server: staticServer.server, pingIntervalMs: 0 });
  const signalPort = await getFreePort();
  let signaling = await startSignalingServer(signalPort);
  const appPort = await getFreePort();
  const appServer = await startAppServer(appPort);
  let relayAppServer = null;
  const securePort = await getFreePort();
  const secureServer = await startSecureDevServer(securePort);

  const baseUrl = `http://127.0.0.1:${staticServer.port}`;
  const signalUrl = `ws://127.0.0.1:${signalPort}`;
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  let relayAppBaseUrl = '';
  const secureBaseUrl = `https://127.0.0.1:${securePort}`;

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

  const fileSize = 512 * 1024; // 512 KB
  const fileBuf = Buffer.allocUnsafe(fileSize);
  for (let i = 0; i < fileSize; i++) fileBuf[i] = i & 0xff;

  const fileSize2 = 128 * 1024; // 128 KB
  const fileBuf2 = Buffer.allocUnsafe(fileSize2);
  for (let i = 0; i < fileSize2; i++) fileBuf2[i] = (i * 7) & 0xff;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ephera-e2e-'));
  const filePathSingle = path.join(tmpDir, 'e2e.bin');
  const filePathA = path.join(tmpDir, 'a.bin');
  const filePathB = path.join(tmpDir, 'b.bin');
  const filePathCrash = path.join(tmpDir, 'crash.bin');
  const filePathPerfLarge = path.join(tmpDir, 'perf-large.bin');
  fs.writeFileSync(filePathSingle, fileBuf);
  fs.writeFileSync(filePathA, fileBuf);
  fs.writeFileSync(filePathB, fileBuf2);
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
    async function runScenario({
      label,
      passphrase,
      files,
      expectAutoPassphrase = false,
      mismatchPassphrase = false,
      expectSendDisabled = false,
      closeReceiverSignaling = false,
      killSignaling = false,
      restartSignaling = false,
      sameOrigin = false,
      baseUrlOverride = '',
      signalUrlOverride = '',
      recvDelayMs = 0,
      checkGc = false,
      expectReceipt = false,
      transferTimeoutMs = 60_000,
      perf = null,
      idleMsBeforeSend = 0,
      contextOptions = null,
      expectRelayPolicy = false,
    }) {
      const activeBaseUrl = baseUrlOverride || baseUrl;
      const activeSignalUrl = signalUrlOverride || signalUrl;
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;
      const passQ = passphrase ? `&passphrase=${encodeURIComponent(passphrase)}` : '';

      const sigQ = sameOrigin ? '' : `&signalUrl=${encodeURIComponent(activeSignalUrl)}`;
      const senderUrl = `${activeBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}${sigQ}${passQ}`;
      const recvDelay = Number.isFinite(recvDelayMs) && recvDelayMs > 0 ? `&recvDelayMs=${Math.floor(recvDelayMs)}` : '';
      const receiverUrl = `${activeBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}${sigQ}${passQ}${recvDelay}`;

      const fileList = (Array.isArray(files) && files.length > 0) ? files : [filePathSingle];
      const expectedCount = fileList.length;
      const expectedNames = fileList.map((f) => (typeof f === 'string' ? path.basename(f) : f.name));
      const expectedTotalBytes = fileList.reduce((sum, f) => {
        if (typeof f === 'string') return sum + fs.statSync(f).size;
        return sum + (f && f.buffer ? f.buffer.length : 0);
      }, 0);

      const senderCtx = await browser.newContext(contextOptions || {});
      const receiverCtx = await browser.newContext(contextOptions || {});

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

        console.log(`--- E2E (${label}): waiting for peer ready ---`);
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 10_000 });

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

        console.log(`--- E2E (${label}): selecting file + sending ---`);
        await sender.setInputFiles('#file-input', fileList);
        console.log(`--- E2E (${label}): files selected ---`);

        if (expectSendDisabled) {
          const disabledNow = await sender.evaluate(() => document.getElementById('send-file').disabled);
          if (!disabledNow) throw new Error('Expected send to remain disabled (likely passphrase mismatch gate failed)');
          await sleep(1500);
          const stillDisabled = await sender.evaluate(() => document.getElementById('send-file').disabled);
          if (!stillDisabled) throw new Error('Expected send to remain disabled (button became enabled unexpectedly)');
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

        if (killSignaling) {
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
        } else {
          const titles = Array.isArray(receiverState.recvTitles) ? receiverState.recvTitles : [];
          for (const name of expectedNames) {
            if (!titles.includes(name)) {
              throw new Error(`Receiver recvTitles missing: ${JSON.stringify(name)} (got ${JSON.stringify(titles)})`);
            }
          }
        }

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

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}`;

      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
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

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}`;
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&autoReady=1&roomId=${encodeURIComponent(roomId)}`;

      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
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
      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
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

          console.log(`--- E2E (${label}): cycle ${i + 1}/${cycles} ---`);

          await Promise.all([
            sender.evaluate((rid) => {
              const el = document.getElementById('room-id');
              if (!el) throw new Error('room-id input missing');
              el.value = rid;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }, roomId),
            receiver.evaluate((rid) => {
              const el = document.getElementById('room-id');
              if (!el) throw new Error('room-id input missing');
              el.value = rid;
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }, roomId),
          ]);

          // Reset per-cycle signaling markers so we can await cleanly.
          await Promise.all([
            sender.evaluate(() => { if (window.__epheraE2E) window.__epheraE2E.signaling = null; }),
            receiver.evaluate(() => { if (window.__epheraE2E) window.__epheraE2E.signaling = null; }),
          ]);

          // Create must happen before join; otherwise join can race and fail "Room not found".
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

      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();

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
        if (!joinLink.includes('autojoin=1')) throw new Error('Expected join link to include autojoin=1');
        if (!joinLink.includes('roomId=')) throw new Error('Expected join link to include roomId');
        if (!joinLink.includes('passphrase=')) throw new Error('Expected join link to include passphrase (test sets checkbox)');

        console.log(`--- E2E (${label}): opening join link on receiver (should auto-join) ---`);
        await receiver.goto(joinLink, { waitUntil: 'domcontentloaded' });

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

    async function runFolderSavePolyfillScenario() {
      const label = 'folder-save-polyfill';
      const roomId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}-${label}`;

      // Use the deploy path (server/serve.js) and same-origin signaling.
      const senderUrl = `${appBaseUrl}/index.html?e2e=1&role=create&roomId=${encodeURIComponent(roomId)}`;
      // Disable autoReady so the "ready" event is produced only by the folder picker path.
      const receiverUrl = `${appBaseUrl}/index.html?e2e=1&role=join&roomId=${encodeURIComponent(roomId)}`;

      const senderCtx = await browser.newContext();
      const receiverCtx = await browser.newContext();
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
        await receiver.evaluate(() => {
          const files = Object.create(null); // name -> { chunks: Uint8Array[], size, data, sum, first16, last16 }

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

          window.__epheraFakeFs = {
            list() { return Object.keys(files); },
            digest(name) {
              const e = files[name];
              if (!e || !e.data) return null;
              return { name, size: e.size >>> 0, sum: e.sum >>> 0, first16: e.first16, last16: e.last16 };
            },
          };

          window.showDirectoryPicker = async () => ({
            async requestPermission() { return 'granted'; },
            async getFileHandle(name, opts) {
              const create = !!(opts && opts.create);
              if (!files[name]) {
                if (!create) {
                  const err = new Error('NotFoundError');
                  err.name = 'NotFoundError';
                  throw err;
                }
                files[name] = { chunks: [], size: 0, data: null, sum: 0, first16: [], last16: [] };
              }
              const entry = files[name];
              return {
                async createWritable() {
                  // Overwrite semantics: createWritable() truncates existing file.
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
          });
        });

        console.log(`--- E2E (${label}): picking receive folder (polyfilled) ---`);
        await receiver.evaluate(() => {
          const btn = document.getElementById('pick-receive-folder');
          if (!btn) throw new Error('pick-receive-folder button not found');
          btn.click();
        });

        // Wait for sender to observe receiver readiness (requires signaling).
        await sender.waitForFunction(() => window.__epheraE2E && window.__epheraE2E.peerReady === true, null, { timeout: 15_000 });

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

        console.log(`--- E2E (${label}) PASS: saved receipt + saved bytes verified (polyfill) ---`);
      } finally {
        try { await senderCtx.close(); } catch {}
        try { await receiverCtx.close(); } catch {}
      }
    }

    await runScenario({ label: 'same-origin', passphrase: null, expectAutoPassphrase: true, sameOrigin: true, expectReceipt: true });
    await runScenario({ label: 'default-secure', passphrase: null, expectAutoPassphrase: true, expectReceipt: true });
    await runScenario({ label: 'passphrase-mismatch', passphrase: null, expectAutoPassphrase: true, mismatchPassphrase: true, expectSendDisabled: true });
    await runScenario({ label: 'plain', passphrase: null, expectReceipt: true });
    await runScenario({
      label: 'multi-plain',
      passphrase: null,
      files: [filePathA, filePathB],
      expectReceipt: true,
    });
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
    await runFolderSavePolyfillScenario();

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

    try { await sameOriginSignaling.close(); } catch {}
    try { staticServer.server.close(); } catch {}
    try { signaling.proc.kill('SIGINT'); } catch {}
    try { appServer.proc.kill('SIGINT'); } catch {}
    try { if (relayAppServer) relayAppServer.proc.kill('SIGINT'); } catch {}
    try { secureServer.proc.kill('SIGINT'); } catch {}

    // Best-effort temp cleanup
    try { fs.unlinkSync(filePathSingle); } catch {}
    try { fs.unlinkSync(filePathA); } catch {}
    try { fs.unlinkSync(filePathB); } catch {}
    try { fs.unlinkSync(filePathCrash); } catch {}
    try { fs.unlinkSync(filePathPerfLarge); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
