const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { createSignalingServer } = require('../signaling');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), timeoutMs)),
  ]);
}

function parsePositiveInt(value, fallback, min = 1) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  const raw = String(value || '').trim();
  if (!raw) return (Date.now() >>> 0);
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n >>> 0;
  }
  let h = 2166136261 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function createPrng(seed) {
  let x = normalizeSeed(seed);
  return function next() {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

function pickInt(rng, min, max) {
  const lo = Math.floor(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  const v = Math.floor(rng() * ((hi - lo) + 1));
  return lo + v;
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1000, reason: '' });
      return;
    }
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason || '') }));
  });
}

function openClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    let settled = false;
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ws);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = (code, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`socket closed before open (code=${code}, reason=${String(reason || '')})`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

function nextJsonMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup();
      try {
        resolve(JSON.parse(String(data)));
      } catch (err) {
        reject(err);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed'));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function loadFuzzConfig() {
  const profileRaw = String(process.env.SIGNALING_FUZZ_PROFILE || '').trim().toLowerCase();
  const profile = profileRaw === 'heavy' ? 'heavy' : 'default';

  const defaults = profile === 'heavy'
    ? {
        clients: 22,
        roundsPerClient: 360,
        settleMs: 450,
        healthTimeoutMs: 2500,
        closeTimeoutMs: 4000,
        drainTimeoutMs: 4500,
      }
    : {
        clients: 8,
        roundsPerClient: 120,
        settleMs: 250,
        healthTimeoutMs: 2000,
        closeTimeoutMs: 2500,
        drainTimeoutMs: 2500,
      };

  const seedRaw = process.env.SIGNALING_FUZZ_SEED;
  const seed = normalizeSeed(seedRaw == null ? Date.now() : seedRaw);

  return {
    profile,
    seed,
    clients: parsePositiveInt(process.env.SIGNALING_FUZZ_CLIENTS, defaults.clients, 1),
    roundsPerClient: parsePositiveInt(process.env.SIGNALING_FUZZ_ROUNDS_PER_CLIENT, defaults.roundsPerClient, 1),
    settleMs: parsePositiveInt(process.env.SIGNALING_FUZZ_SETTLE_MS, defaults.settleMs, 0),
    healthTimeoutMs: parsePositiveInt(process.env.SIGNALING_FUZZ_HEALTH_TIMEOUT_MS, defaults.healthTimeoutMs, 500),
    closeTimeoutMs: parsePositiveInt(process.env.SIGNALING_FUZZ_CLOSE_TIMEOUT_MS, defaults.closeTimeoutMs, 500),
    drainTimeoutMs: parsePositiveInt(process.env.SIGNALING_FUZZ_DRAIN_TIMEOUT_MS, defaults.drainTimeoutMs, 500),
    summaryPath: String(process.env.SIGNALING_FUZZ_SUMMARY_PATH || '').trim(),
  };
}

async function withServer(options, fn) {
  const server = createSignalingServer({
    host: '127.0.0.1',
    port: 0,
    pingIntervalMs: 0,
    ...options,
  });
  await server.ready;

  const url = `ws://127.0.0.1:${server.port}`;
  try {
    await fn({ server, url });
  } finally {
    await server.close();
  }
}

async function closeMany(sockets, timeoutMs) {
  await Promise.all(sockets.map(async (ws, idx) => {
    if (!ws) return;
    try { ws.close(); } catch {}
    await withTimeout(waitForClose(ws), timeoutMs, `close socket ${idx}`);
  }));
}

async function waitForCondition(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    if (fn()) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error(label || 'condition timeout');
}

function makeFuzzPayload(op, rng, token) {
  switch (op) {
    case 0:
      return { kind: 'text', data: '{"type":"signal","payload":' };
    case 1:
      return { kind: 'text', data: '{"badJson":true' };
    case 2:
      return { kind: 'json', data: { x: token } };
    case 3:
      return { kind: 'json', data: { type: 'unknown-type', payload: token } };
    case 4:
      return { kind: 'json', data: { type: 'create-room', roomId: `bad room ${token}` } };
    case 5:
      return { kind: 'json', data: { type: 'join-room', roomId: `missing-${token}` } };
    case 6:
      return { kind: 'json', data: { type: 'signal', payload: { fuzz: token } } };
    case 7:
      return { kind: 'json', data: { type: 'rotate-room-join-key' } };
    case 8:
      return { kind: 'json', data: { type: 'close-room' } };
    case 9:
      return { kind: 'json', data: { type: 'leave-room' } };
    case 10:
      return { kind: 'buffer', data: Buffer.from([0xde, 0xad, 0xbe, 0xef, pickInt(rng, 0, 255)]) };
    case 11:
      return { kind: 'text', data: 'x'.repeat(72 * 1024) }; // intentionally above maxPayloadBytes in fuzz server
    default:
      return { kind: 'json', data: { type: 'join-room', roomId: `x-${token}`, roomJoinKey: 'bad' } };
  }
}

function writeFuzzSummary(summary, summaryPath) {
  if (!summaryPath) return;
  try {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  } catch {}
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

async function testSeededMalformedTraffic(cfg) {
  const rng = createPrng(cfg.seed);
  const stats = {
    sentFrames: 0,
    sendErrors: 0,
    receivedFrames: 0,
    parseErrors: 0,
    errorMessages: 0,
    socketCloses: 0,
  };

  await withServer({
    maxConnections: Math.max(128, cfg.clients + 16),
    maxConnectionsPerIp: Math.max(128, cfg.clients + 16),
    maxMessagesPerWindow: Math.max(500, cfg.roundsPerClient + 100),
    maxMessagesPerIpPerWindow: Math.max(5000, (cfg.clients * cfg.roundsPerClient) + 1000),
    maxPayloadBytes: 64 * 1024,
    joinDenyDelayMs: 0,
  }, async ({ server, url }) => {
    const sockets = await Promise.all(Array.from({ length: cfg.clients }, () => openClient(url)));

    for (const ws of sockets) {
      ws.on('close', () => {
        stats.socketCloses += 1;
      });
      ws.on('message', (raw) => {
        stats.receivedFrames += 1;
        try {
          const msg = JSON.parse(String(raw));
          if (msg && msg.type === 'error') stats.errorMessages += 1;
        } catch {
          stats.parseErrors += 1;
        }
      });
    }

    for (let c = 0; c < sockets.length; c++) {
      const ws = sockets[c];
      for (let r = 0; r < cfg.roundsPerClient; r++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const op = pickInt(rng, 0, 12);
        const token = `${c}-${r}-${pickInt(rng, 0, 1_000_000)}`;
        const payload = makeFuzzPayload(op, rng, token);
        try {
          if (payload.kind === 'json') ws.send(JSON.stringify(payload.data));
          else ws.send(payload.data);
          stats.sentFrames += 1;
        } catch {
          stats.sendErrors += 1;
        }
      }
    }

    await sleep(cfg.settleMs);

    // Health probe after fuzz traffic: server must still process valid room flow.
    const healthA = await openClient(url);
    const healthB = await openClient(url);
    let healthKey = '';
    try {
      const healthRoomId = `fuzz-health-${cfg.seed}`;
      healthA.send(JSON.stringify({ type: 'create-room', roomId: healthRoomId }));
      const created = await withTimeout(nextJsonMessage(healthA), cfg.healthTimeoutMs, 'fuzz health create');
      assert.strictEqual(created.type, 'room-created');
      healthKey = created.roomJoinKey;
      assert.strictEqual(typeof healthKey, 'string');

      const peerJoinedP = withTimeout(nextJsonMessage(healthA), cfg.healthTimeoutMs, 'fuzz health peer-joined');
      healthB.send(JSON.stringify({
        type: 'join-room',
        roomId: healthRoomId,
        roomJoinKey: healthKey,
      }));
      const joined = await withTimeout(nextJsonMessage(healthB), cfg.healthTimeoutMs, 'fuzz health join');
      const peerJoined = await peerJoinedP;
      assert.strictEqual(joined.type, 'room-joined');
      assert.strictEqual(peerJoined.type, 'peer-joined');

      healthA.send(JSON.stringify({ type: 'signal', payload: { ok: true, seed: cfg.seed } }));
      const relayed = await withTimeout(nextJsonMessage(healthB), cfg.healthTimeoutMs, 'fuzz health signal relay');
      assert.strictEqual(relayed.type, 'signal');
      assert.deepStrictEqual(relayed.payload, { ok: true, seed: cfg.seed });
    } finally {
      await closeMany([healthA, healthB], cfg.closeTimeoutMs);
    }

    await closeMany(sockets, cfg.closeTimeoutMs);
    await waitForCondition(
      () => server.rooms.countRooms() === 0,
      cfg.drainTimeoutMs,
      'rooms did not drain to zero after fuzz test'
    );
  });

  return stats;
}

async function runSignalingFuzzTestSuite() {
  const cfg = loadFuzzConfig();
  const startedAt = Date.now();
  let stats = null;
  let error = null;

  console.log(`SIGNALING_FUZZ_SEED ${cfg.seed}`);

  try {
    stats = await testSeededMalformedTraffic(cfg);
  } catch (err) {
    error = err;
    throw err;
  } finally {
    const summary = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      profile: cfg.profile,
      seed: cfg.seed,
      config: {
        clients: cfg.clients,
        roundsPerClient: cfg.roundsPerClient,
        settleMs: cfg.settleMs,
        healthTimeoutMs: cfg.healthTimeoutMs,
        closeTimeoutMs: cfg.closeTimeoutMs,
        drainTimeoutMs: cfg.drainTimeoutMs,
      },
      stats: stats || null,
      totalDurationMs: Math.max(0, Date.now() - startedAt),
      ok: !error,
      error: error ? String(error && error.stack ? error.stack : error) : null,
    };
    writeFuzzSummary(summary, cfg.summaryPath);
    try { console.log(`SIGNALING_FUZZ_SUMMARY ${JSON.stringify(summary)}`); } catch {}
  }
}

if (require.main === module) {
  runSignalingFuzzTestSuite().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  runSignalingFuzzTestSuite,
};
