const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { createSignalingServer } = require('../signaling');

function parsePositiveInt(value, fallback, min = 1) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function loadStressConfig() {
  const profileRaw = String(process.env.SIGNALING_STRESS_PROFILE || '').trim().toLowerCase();
  const profile = profileRaw === 'heavy' ? 'heavy' : 'default';

  const defaults = profile === 'heavy'
    ? {
        pairs: 28,
        burst: 24,
        clients: 18,
        rounds: 8,
        joinAckTimeoutMs: 6000,
        signalTimeoutMs: 15000,
        drainTimeoutMs: 5000,
      }
    : {
        pairs: 12,
        burst: 10,
        clients: 8,
        rounds: 4,
        joinAckTimeoutMs: 2000,
        signalTimeoutMs: 6000,
        drainTimeoutMs: 2500,
      };

  return {
    profile,
    pairs: parsePositiveInt(process.env.SIGNALING_STRESS_PAIRS, defaults.pairs, 1),
    burst: parsePositiveInt(process.env.SIGNALING_STRESS_BURST, defaults.burst, 1),
    clients: parsePositiveInt(process.env.SIGNALING_STRESS_CLIENTS, defaults.clients, 2),
    rounds: parsePositiveInt(process.env.SIGNALING_STRESS_ROUNDS, defaults.rounds, 1),
    joinAckTimeoutMs: parsePositiveInt(process.env.SIGNALING_STRESS_JOIN_TIMEOUT_MS, defaults.joinAckTimeoutMs, 500),
    signalTimeoutMs: parsePositiveInt(process.env.SIGNALING_STRESS_SIGNAL_TIMEOUT_MS, defaults.signalTimeoutMs, 1000),
    drainTimeoutMs: parsePositiveInt(process.env.SIGNALING_STRESS_DRAIN_TIMEOUT_MS, defaults.drainTimeoutMs, 500),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), timeoutMs)),
  ]);
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

function waitForClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1000, reason: '' });
      return;
    }
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason || '') }));
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

function collectNSignalPayloads(ws, count, label = 'signals') {
  return new Promise((resolve, reject) => {
    const target = Math.max(1, Math.floor(Number(count) || 1));
    const payloads = [];

    const onMessage = (data) => {
      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (msg && msg.type === 'signal') {
        payloads.push(msg.payload);
        if (payloads.length >= target) {
          cleanup();
          resolve(payloads);
        }
        return;
      }

      if (msg && msg.type === 'error') {
        cleanup();
        reject(new Error(`${label}: unexpected error (${String(msg.message || '')})`));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label}: socket closed`));
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

async function createRoom(ws, roomId) {
  ws.send(JSON.stringify({ type: 'create-room', roomId }));
  const created = await withTimeout(nextJsonMessage(ws), 1500, `create-room ack (${roomId})`);
  assert.strictEqual(created.type, 'room-created');
  assert.strictEqual(created.roomId, roomId);
  assert.strictEqual(typeof created.roomJoinKey, 'string');
  assert.ok(created.roomJoinKey.length >= 16);
  return created;
}

async function closeMany(sockets) {
  await Promise.all(sockets.map(async (ws, idx) => {
    try { ws.close(); } catch {}
    await withTimeout(waitForClose(ws), 3000, `close socket ${idx}`);
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

async function testConcurrentRoomSignalBursts(cfg = loadStressConfig()) {
  const PAIRS = cfg.pairs;
  const BURST = cfg.burst;
  const RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  await withServer({
    maxConnections: Math.max(128, (PAIRS * 2) + 16),
    maxConnectionsPerIp: Math.max(128, (PAIRS * 2) + 16),
    maxMessagesPerWindow: Math.max(4000, BURST * 8),
    maxMessagesPerIpPerWindow: Math.max(20000, (PAIRS * BURST * 4) + 1000),
    joinDenyDelayMs: 0,
  }, async ({ server, url }) => {
    const owners = await Promise.all(Array.from({ length: PAIRS }, () => openClient(url)));
    const joiners = await Promise.all(Array.from({ length: PAIRS }, () => openClient(url)));
    const allSockets = owners.concat(joiners);

    try {
      const created = await Promise.all(owners.map((ws, i) => createRoom(ws, `stress-room-${RUN_ID}-${i}`)));

      const joinAckPromises = joiners.map((ws, i) => (
        withTimeout(nextJsonMessage(ws), cfg.joinAckTimeoutMs, `join-room ack ${i}`)
      ));
      const peerJoinedPromises = owners.map((ws, i) => (
        withTimeout(nextJsonMessage(ws), cfg.joinAckTimeoutMs, `peer-joined notify ${i}`)
      ));

      for (let i = 0; i < PAIRS; i++) {
        joiners[i].send(JSON.stringify({
          type: 'join-room',
          roomId: created[i].roomId,
          roomJoinKey: created[i].roomJoinKey,
        }));
      }

      const [joinAcks, peerJoined] = await Promise.all([
        Promise.all(joinAckPromises),
        Promise.all(peerJoinedPromises),
      ]);
      for (let i = 0; i < PAIRS; i++) {
        assert.strictEqual(joinAcks[i].type, 'room-joined');
        assert.strictEqual(peerJoined[i].type, 'peer-joined');
      }
      assert.strictEqual(server.rooms.countRooms(), PAIRS);

      const ownerSignalReceives = owners.map((ws, i) => (
        withTimeout(
          collectNSignalPayloads(ws, BURST, `owner ${i} signal receive`),
          cfg.signalTimeoutMs,
          `owner ${i} signal timeout`
        )
      ));
      const joinerSignalReceives = joiners.map((ws, i) => (
        withTimeout(
          collectNSignalPayloads(ws, BURST, `joiner ${i} signal receive`),
          cfg.signalTimeoutMs,
          `joiner ${i} signal timeout`
        )
      ));

      for (let i = 0; i < PAIRS; i++) {
        for (let seq = 0; seq < BURST; seq++) {
          owners[i].send(JSON.stringify({
            type: 'signal',
            payload: { from: 'owner', pair: i, seq },
          }));
          joiners[i].send(JSON.stringify({
            type: 'signal',
            payload: { from: 'joiner', pair: i, seq },
          }));
        }
      }

      const [ownerPayloads, joinerPayloads] = await Promise.all([
        Promise.all(ownerSignalReceives),
        Promise.all(joinerSignalReceives),
      ]);

      for (let i = 0; i < PAIRS; i++) {
        const toOwner = ownerPayloads[i];
        const toJoiner = joinerPayloads[i];
        assert.strictEqual(toOwner.length, BURST);
        assert.strictEqual(toJoiner.length, BURST);
        for (const p of toOwner) {
          assert.strictEqual(p.from, 'joiner');
          assert.strictEqual(p.pair, i);
          assert.ok(Number.isInteger(p.seq));
        }
        for (const p of toJoiner) {
          assert.strictEqual(p.from, 'owner');
          assert.strictEqual(p.pair, i);
          assert.ok(Number.isInteger(p.seq));
        }
      }
    } finally {
      await closeMany(allSockets);
    }

    await waitForCondition(
      () => server.rooms.countRooms() === 0,
      cfg.drainTimeoutMs,
      'rooms did not drain after concurrent close'
    );
  });
}

async function testRoomOpsBurstThrottlesWithoutCrash(cfg = loadStressConfig()) {
  const CLIENTS = cfg.clients;
  const ROUNDS = cfg.rounds;
  const maxRoomOpsPerIpPerWindow = Math.max(20, Math.floor((CLIENTS * ROUNDS) / 2));

  await withServer({
    maxConnectionsPerIp: 64,
    maxMessagesPerWindow: Math.max(500, CLIENTS * 20),
    maxMessagesPerIpPerWindow: Math.max(5000, CLIENTS * ROUNDS * 50),
    maxRoomOpsPerIpPerWindow,
    roomOpsWindowMs: 8000,
    roomOpsCooldownMs: 220,
    joinDenyDelayMs: 0,
  }, async ({ url }) => {
    const sockets = await Promise.all(Array.from({ length: CLIENTS }, () => openClient(url)));
    try {
      let joinUnavailableCount = 0;
      let throttledCount = 0;

      for (let round = 0; round < ROUNDS; round++) {
        const responsePromises = sockets.map((ws, i) => (
          withTimeout(nextJsonMessage(ws), cfg.joinAckTimeoutMs, `room-op response r${round} c${i}`)
        ));

        for (let i = 0; i < CLIENTS; i++) {
          sockets[i].send(JSON.stringify({
            type: 'join-room',
            roomId: `stress-miss-${round}-${i}`,
          }));
        }

        const responses = await Promise.all(responsePromises);
        for (const msg of responses) {
          assert.strictEqual(msg.type, 'error');
          if (msg.message === 'Join unavailable') {
            joinUnavailableCount += 1;
            continue;
          }
          if (msg.message === 'Too many room operations; retry later') {
            throttledCount += 1;
            assert.ok(Number.isFinite(msg.retryAfterMs));
            assert.ok(msg.retryAfterMs >= 1);
            continue;
          }
          assert.fail(`unexpected room-op response: ${JSON.stringify(msg)}`);
        }
      }

      assert.ok(joinUnavailableCount > 0, 'expected at least one Join unavailable response');
      assert.ok(throttledCount > 0, 'expected at least one throttled room-op response');

      await sleep(280);

      sockets[0].send(JSON.stringify({ type: 'create-room', roomId: 'stress-recovery-room' }));
      const recovery = await withTimeout(nextJsonMessage(sockets[0]), cfg.joinAckTimeoutMs, 'room-op recovery create');
      assert.strictEqual(recovery.type, 'room-created');
      assert.strictEqual(recovery.roomId, 'stress-recovery-room');
      assert.strictEqual(typeof recovery.roomJoinKey, 'string');
      assert.ok(recovery.roomJoinKey.length >= 16);
    } finally {
      await closeMany(sockets);
    }
  });
}

function writeStressSummary(summary) {
  const outPath = String(process.env.SIGNALING_STRESS_SUMMARY_PATH || '').trim();
  if (!outPath) return;

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  } catch {}

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
}

async function runTimedCheck(name, fn) {
  const startedAt = Date.now();
  await fn();
  return {
    name,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

async function runSignalingStressTestSuite() {
  const cfg = loadStressConfig();
  const suiteStartedAt = Date.now();
  const checks = [];

  checks.push(await runTimedCheck(
    'concurrent-room-signal-bursts',
    () => testConcurrentRoomSignalBursts(cfg)
  ));
  checks.push(await runTimedCheck(
    'room-ops-burst-throttles-without-crash',
    () => testRoomOpsBurstThrottlesWithoutCrash(cfg)
  ));

  const totalDurationMs = Math.max(0, Date.now() - suiteStartedAt);
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: cfg.profile,
    config: {
      pairs: cfg.pairs,
      burst: cfg.burst,
      clients: cfg.clients,
      rounds: cfg.rounds,
      joinAckTimeoutMs: cfg.joinAckTimeoutMs,
      signalTimeoutMs: cfg.signalTimeoutMs,
      drainTimeoutMs: cfg.drainTimeoutMs,
    },
    expectedLoads: {
      totalSocketsSignalBurst: cfg.pairs * 2,
      signalsPerDirectionPerPair: cfg.burst,
      totalSignalsRelayedPerDirection: cfg.pairs * cfg.burst,
      roomOpsAttempts: cfg.clients * cfg.rounds,
    },
    checks,
    totalDurationMs,
  };

  writeStressSummary(summary);
  try { console.log(`SIGNALING_STRESS_SUMMARY ${JSON.stringify(summary)}`); } catch {}
}

module.exports = {
  runSignalingStressTestSuite,
};
