/* eslint-disable no-console */
/**
 * Staging smoke validation gate (manual workflow target).
 *
 * Verifies against an already deployed Ephera environment:
 * 1) create + join room
 * 2) WebRTC transport open
 * 3) small file transfer success
 * 4) receiver cancel propagates sender abort
 *
 * Inputs (env):
 * - STAGING_BASE_URL (required): e.g. https://staging.example.com
 * - STAGING_SIGNAL_URL (optional): explicit ws/wss signaling URL override
 * - CHROME_PATH (optional): browser executable path
 * - STAGING_SMOKE_SUMMARY_PATH (optional): JSON summary output path
 * - STAGING_IGNORE_HTTPS_ERRORS (optional): default true
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;
const DEFAULT_ABORT_TIMEOUT_MS = 25_000;
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const DEFAULT_LARGE_FILE_BYTES = 32 * 1024 * 1024;
const SMALL_FILE_BYTES = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Missing STAGING_BASE_URL');
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid STAGING_BASE_URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`STAGING_BASE_URL must start with http:// or https:// (got ${parsed.protocol})`);
  }
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function parseOptionalSignalUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid STAGING_SIGNAL_URL: ${input}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`STAGING_SIGNAL_URL must start with ws:// or wss:// (got ${parsed.protocol})`);
  }
  parsed.hash = '';
  return parsed.toString();
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

function resolveChromePath() {
  const requested = String(process.env.CHROME_PATH || '').trim();
  if (requested) {
    if (!fs.existsSync(requested)) throw new Error(`CHROME_PATH not found: ${requested}`);
    return requested;
  }

  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome executable not found. Set CHROME_PATH.');
}

function createRoomJoinKey(seed = '') {
  return `staging-${Buffer.from(`${Date.now()}-${randomUUID()}-${seed}`, 'utf8').toString('hex').slice(0, 56)}`;
}

function safeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err && typeof err.stack === 'string') return err.stack;
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

function makeScenarioUrls({ baseUrl, signalUrl, label, recvDelayMs = 0 }) {
  const roomId = `staging-${Date.now()}-${randomUUID().slice(0, 8)}-${label}`;
  const roomJoinKey = createRoomJoinKey(label);
  const hash = new URLSearchParams({ roomJoinKey }).toString();

  const senderUrl = new URL('/index.html', `${baseUrl}/`);
  senderUrl.searchParams.set('e2e', '1');
  senderUrl.searchParams.set('role', 'create');
  senderUrl.searchParams.set('roomId', roomId);
  if (signalUrl) senderUrl.searchParams.set('signalUrl', signalUrl);
  senderUrl.hash = hash;

  const receiverUrl = new URL('/index.html', `${baseUrl}/`);
  receiverUrl.searchParams.set('e2e', '1');
  receiverUrl.searchParams.set('role', 'join');
  receiverUrl.searchParams.set('autoReady', '1');
  receiverUrl.searchParams.set('roomId', roomId);
  if (Number.isFinite(recvDelayMs) && recvDelayMs > 0) {
    receiverUrl.searchParams.set('recvDelayMs', String(Math.floor(recvDelayMs)));
  }
  if (signalUrl) receiverUrl.searchParams.set('signalUrl', signalUrl);
  receiverUrl.hash = hash;

  return {
    roomId,
    roomJoinKey,
    senderUrl: senderUrl.toString(),
    receiverUrl: receiverUrl.toString(),
  };
}

async function runCheck(summary, name, fn) {
  const start = Date.now();
  const check = {
    name,
    ok: false,
    startedAt: nowIso(),
    durationMs: 0,
  };
  summary.checks.push(check);

  try {
    const details = await fn();
    check.ok = true;
    check.details = details || {};
    return details;
  } catch (err) {
    check.ok = false;
    check.error = safeError(err);
    throw err;
  } finally {
    check.durationMs = Date.now() - start;
    check.finishedAt = nowIso();
  }
}

async function closeContext(ctx) {
  if (!ctx) return;
  try { await ctx.close(); } catch {}
}

async function getE2EState(page) {
  try {
    return await page.evaluate(() => window.__epheraE2E || null);
  } catch {
    return null;
  }
}

async function main() {
  const { chromium } = require('playwright-core');

  const baseUrl = normalizeBaseUrl(process.env.STAGING_BASE_URL);
  const signalUrl = parseOptionalSignalUrl(process.env.STAGING_SIGNAL_URL);
  const ignoreHTTPSErrors = parseBool(process.env.STAGING_IGNORE_HTTPS_ERRORS, true);
  const transferTimeoutMs = parsePositiveInt(process.env.STAGING_TRANSFER_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS);
  const abortTimeoutMs = parsePositiveInt(process.env.STAGING_ABORT_TIMEOUT_MS, DEFAULT_ABORT_TIMEOUT_MS);
  const waitTimeoutMs = parsePositiveInt(process.env.STAGING_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS);
  const largeFileBytes = parsePositiveInt(process.env.STAGING_ABORT_FILE_BYTES, DEFAULT_LARGE_FILE_BYTES);
  const chromePath = resolveChromePath();
  const summaryPath = path.resolve(
    process.env.STAGING_SMOKE_SUMMARY_PATH
      || path.join(process.cwd(), 'artifacts', 'staging-smoke-summary.json')
  );

  const summary = {
    ok: false,
    startedAt: nowIso(),
    baseUrl,
    signalUrl: signalUrl || null,
    chromePath,
    checks: [],
  };
  const globalStart = Date.now();

  let browser = null;
  let pair = null;

  async function closePair() {
    if (!pair) return;
    await closeContext(pair.senderCtx);
    await closeContext(pair.receiverCtx);
    pair = null;
  }

  async function openPair({ label, recvDelayMs = 0 }) {
    await closePair();
    const scenario = makeScenarioUrls({
      baseUrl,
      signalUrl,
      label,
      recvDelayMs,
    });

    const senderCtx = await browser.newContext({ ignoreHTTPSErrors });
    const receiverCtx = await browser.newContext({ ignoreHTTPSErrors });
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    try {
      await sender.goto(scenario.senderUrl, { waitUntil: 'domcontentloaded' });
      await sender.waitForFunction(
        () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-created',
        null,
        { timeout: waitTimeoutMs }
      );

      await receiver.goto(scenario.receiverUrl, { waitUntil: 'domcontentloaded' });
      await receiver.waitForFunction(
        () => window.__epheraE2E && window.__epheraE2E.signaling === 'room-joined',
        null,
        { timeout: waitTimeoutMs }
      );

      await Promise.all([
        sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.transportOpen === true,
          null,
          { timeout: waitTimeoutMs }
        ),
        receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.transportOpen === true,
          null,
          { timeout: waitTimeoutMs }
        ),
      ]);

      await sender.waitForFunction(
        () => window.__epheraE2E && window.__epheraE2E.peerReady === true,
        null,
        { timeout: waitTimeoutMs }
      );
    } catch (err) {
      await closeContext(senderCtx);
      await closeContext(receiverCtx);
      throw err;
    }

    pair = {
      scenario,
      senderCtx,
      receiverCtx,
      sender,
      receiver,
    };
    return pair;
  }

  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    });

    await runCheck(summary, 'create_join_transport', async () => {
      const opened = await openPair({ label: 'smoke' });
      const [senderState, receiverState] = await Promise.all([getE2EState(opened.sender), getE2EState(opened.receiver)]);
      if (!senderState || !receiverState) throw new Error('Missing __epheraE2E state after transport open');
      return {
        roomId: opened.scenario.roomId,
        senderSignaling: senderState.signaling,
        receiverSignaling: receiverState.signaling,
        senderTransportOpen: !!senderState.transportOpen,
        receiverTransportOpen: !!receiverState.transportOpen,
        peerReady: !!senderState.peerReady,
      };
    });

    await runCheck(summary, 'small_transfer_success', async () => {
      if (!pair) throw new Error('Pair not initialized before small transfer check');
      const { sender, receiver } = pair;

      await sender.evaluate(() => {
        const clear = document.getElementById('clear-passphrase');
        if (clear) clear.click();
      });

      const payload = {
        name: 'staging-small.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(SMALL_FILE_BYTES, 0x61),
      };

      await sender.setInputFiles('#file-input', [payload]);
      await sender.waitForFunction(
        () => {
          const btn = document.getElementById('send-file');
          return !!(btn && btn.disabled === false);
        },
        null,
        { timeout: waitTimeoutMs }
      );
      await sender.click('#send-file');

      await Promise.all([
        sender.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.sentDoneCount >= 1,
          null,
          { timeout: transferTimeoutMs }
        ),
        receiver.waitForFunction(
          () => window.__epheraE2E && window.__epheraE2E.recvDoneCount >= 1,
          null,
          { timeout: transferTimeoutMs }
        ),
      ]);

      const [senderState, receiverState] = await Promise.all([getE2EState(sender), getE2EState(receiver)]);
      if (!senderState || !receiverState) throw new Error('Missing __epheraE2E state after small transfer');
      if (senderState.error) throw new Error(`Sender reported error: ${senderState.error}`);
      if (receiverState.error) throw new Error(`Receiver reported error: ${receiverState.error}`);
      if (senderState.sentTotalBytes < SMALL_FILE_BYTES) {
        throw new Error(`Expected sentTotalBytes >= ${SMALL_FILE_BYTES}, got ${senderState.sentTotalBytes}`);
      }
      if (receiverState.recvTotalBytes < SMALL_FILE_BYTES) {
        throw new Error(`Expected recvTotalBytes >= ${SMALL_FILE_BYTES}, got ${receiverState.recvTotalBytes}`);
      }

      return {
        sentDoneCount: senderState.sentDoneCount,
        recvDoneCount: receiverState.recvDoneCount,
        sentTotalBytes: senderState.sentTotalBytes,
        recvTotalBytes: receiverState.recvTotalBytes,
      };
    });

    await runCheck(summary, 'receiver_cancel_aborts_sender', async () => {
      await openPair({ label: 'abort', recvDelayMs: 8 });
      if (!pair) throw new Error('Pair not initialized before abort check');
      const { sender, receiver } = pair;

      await sender.evaluate(() => {
        const clear = document.getElementById('clear-passphrase');
        if (clear) clear.click();
      });

      const senderBefore = await getE2EState(sender);
      const receiverBefore = await getE2EState(receiver);
      if (!senderBefore || !receiverBefore) throw new Error('Missing baseline __epheraE2E state for abort check');

      const sentDoneBase = Number(senderBefore.sentDoneCount || 0);
      const recvDoneBase = Number(receiverBefore.recvDoneCount || 0);
      const sentAbortBase = Number(senderBefore.sentAbortCount || 0);
      const sentBytesBase = Number(senderBefore.sentBytes || 0);
      const recvBytesBase = Number(receiverBefore.recvBytes || 0);

      const payload = {
        name: 'staging-abort.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(largeFileBytes, 0x42),
      };

      await sender.setInputFiles('#file-input', [payload]);
      await sender.waitForFunction(
        () => {
          const btn = document.getElementById('send-file');
          return !!(btn && btn.disabled === false);
        },
        null,
        { timeout: waitTimeoutMs }
      );
      await sender.click('#send-file');

      await Promise.all([
        sender.waitForFunction(
          ({ minSentBytes, sentDoneCount }) => {
            const s = window.__epheraE2E;
            return !!(s && s.sentBytes > minSentBytes && s.sentDoneCount === sentDoneCount);
          },
          { minSentBytes: sentBytesBase, sentDoneCount: sentDoneBase },
          { timeout: waitTimeoutMs }
        ),
        receiver.waitForFunction(
          ({ minRecvBytes, recvDoneCount: expectedRecvDone }) => {
            const s = window.__epheraE2E;
            return !!(s && s.recvBytes > minRecvBytes && s.recvDoneCount === expectedRecvDone);
          },
          { minRecvBytes: recvBytesBase, recvDoneCount: recvDoneBase },
          { timeout: waitTimeoutMs }
        ),
      ]);

      await receiver.waitForFunction(
        () => {
          const btn = document.querySelector('.transfer-in .transfer-cancel');
          return !!(btn && !btn.hidden && !btn.disabled);
        },
        null,
        { timeout: waitTimeoutMs }
      );
      await receiver.evaluate(() => {
        const btn = document.querySelector('.transfer-in .transfer-cancel');
        if (!btn) throw new Error('Receiver cancel button not found');
        btn.click();
      });

      await sender.waitForFunction(
        (baseAbortCount) => {
          const s = window.__epheraE2E;
          return !!(s && (s.sentAbortCount > baseAbortCount || s.error));
        },
        sentAbortBase,
        { timeout: abortTimeoutMs }
      );

      const senderAfter = await getE2EState(sender);
      const receiverAfter = await getE2EState(receiver);
      if (!senderAfter || !receiverAfter) throw new Error('Missing final __epheraE2E state for abort check');
      if (senderAfter.sentAbortCount <= sentAbortBase) {
        throw new Error(`Expected sender sentAbortCount > ${sentAbortBase}, got ${senderAfter.sentAbortCount}`);
      }
      if (senderAfter.sentDoneCount !== sentDoneBase) {
        throw new Error(`Expected sender sentDoneCount to remain ${sentDoneBase}, got ${senderAfter.sentDoneCount}`);
      }
      if (senderAfter.error) {
        throw new Error(`Receiver cancellation must not report a sender error: ${senderAfter.error}`);
      }
      if (senderAfter.lastOutboundOutcome !== 'receiver-cancelled') {
        throw new Error(`Expected lastOutboundOutcome=receiver-cancelled, got ${senderAfter.lastOutboundOutcome}`);
      }

      return {
        sentAbortCountBefore: sentAbortBase,
        sentAbortCountAfter: senderAfter.sentAbortCount,
        sentDoneCountBefore: sentDoneBase,
        sentDoneCountAfter: senderAfter.sentDoneCount,
        senderError: senderAfter.error || null,
        receiverError: receiverAfter.error || null,
      };
    });

    summary.ok = true;
  } catch (err) {
    summary.ok = false;
    summary.error = safeError(err);
    console.error(summary.error);
  } finally {
    await closePair();
    if (browser) {
      try { await browser.close(); } catch {}
    }
    summary.totalDurationMs = Date.now() - globalStart;
    summary.finishedAt = nowIso();
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`staging-smoke summary -> ${summaryPath}`);
    console.log(JSON.stringify({
      ok: summary.ok,
      checks: summary.checks.map((c) => ({ name: c.name, ok: c.ok, durationMs: c.durationMs })),
      totalDurationMs: summary.totalDurationMs,
    }));
  }

  if (!summary.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(safeError(err));
  process.exit(1);
});
