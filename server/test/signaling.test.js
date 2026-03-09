const assert = require('assert');
const WebSocket = require('ws');

const { createSignalingServer } = require('../signaling');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), timeoutMs)),
  ]);
}

function openClient(url) {
  return openClientWithOptions(url, {});
}

function openClientWithOptions(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);

    // Some failures can close the socket before 'open' or 'error' fires.
    // Ensure this promise always settles.
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

function nextNJsonMessages(ws, count) {
  return new Promise((resolve, reject) => {
    const target = Math.max(1, Math.floor(Number(count) || 1));
    const out = [];

    const onMessage = (data) => {
      try {
        out.push(JSON.parse(String(data)));
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (out.length >= target) {
        cleanup();
        resolve(out);
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

function waitForClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1000, reason: '' });
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason || '') }));
  });
}

async function withServer(opts, fn) {
  const server = createSignalingServer({
    host: '127.0.0.1',
    port: 0,
    pingIntervalMs: 0,
    ...opts,
  });
  await server.ready;

  const url = `ws://127.0.0.1:${server.port}`;
  try {
    await fn({ server, url });
  } finally {
    await server.close();
  }
}

function makeRoomJoinKey(seed = 'room-auth') {
  return `${String(seed).replace(/[^A-Za-z0-9_-]/g, '')}-k1234567890abcd`;
}

async function createRoom(ws, roomId, label = 'create-room ack', roomJoinKey) {
  const payload = { type: 'create-room', roomId };
  if (typeof roomJoinKey === 'string') payload.roomJoinKey = roomJoinKey;
  ws.send(JSON.stringify(payload));
  const created = await withTimeout(nextJsonMessage(ws), 1000, label);
  assert.strictEqual(created.type, 'room-created');
  assert.strictEqual(created.roomId, roomId);
  assert.strictEqual(typeof created.roomJoinKey, 'string');
  assert.ok(created.roomJoinKey.length >= 16);
  assert.strictEqual(typeof created.peerId, 'string');
  assert.ok(created.peerId.length >= 8);
  assert.strictEqual(created.roomOwnerPeerId, created.peerId);
  assert.strictEqual(created.role, 'owner');
  return created;
}

async function testRelaySignal() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-relay', 'create-room ack');
    assert.strictEqual(created.peerCount, 1);

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-relay', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join-room ack');
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(joined.peerCount, 2);

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer-joined notify');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    a.send(JSON.stringify({ type: 'signal', payload: { hello: 'world' } }));
    const sig = await withTimeout(nextJsonMessage(b), 1000, 'signal relay');
    assert.strictEqual(sig.type, 'signal');
    assert.deepStrictEqual(sig.payload, { hello: 'world' });

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testRoomFull() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = await openClient(url);

    const created = await createRoom(a, 'room-full', 'create ack');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-full', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join ack');
    assert.strictEqual(joined.type, 'room-joined');

    // a receives peer-joined
    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    c.send(JSON.stringify({ type: 'join-room', roomId: 'room-full', roomJoinKey: created.roomJoinKey }));
    const err = await withTimeout(nextJsonMessage(c), 1000, 'room full error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Join unavailable');

    assert.strictEqual(a.readyState, WebSocket.OPEN);
    assert.strictEqual(b.readyState, WebSocket.OPEN);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    try { c.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
    await withTimeout(waitForClose(c), 1000, 'close c');
  });
}

async function testCreateRoomCollision() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-collide', 'created');

    b.send(JSON.stringify({ type: 'create-room', roomId: 'room-collide' }));
    const err = await withTimeout(nextJsonMessage(b), 1000, 'collision error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Room already exists');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testInvalidRoomId() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'bad room id' }));
    const err = await withTimeout(nextJsonMessage(a), 1000, 'invalid id error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Invalid roomId');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testInvalidRoomJoinKey() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-invalid-key', roomJoinKey: 'bad key with spaces' }));
    const err = await withTimeout(nextJsonMessage(a), 1000, 'invalid key error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Invalid roomJoinKey');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testSignalWithoutRoom() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);

    a.send(JSON.stringify({ type: 'signal', payload: { x: 1 } }));
    const err = await withTimeout(nextJsonMessage(a), 1000, 'signal error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Not in a room');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testAllowedOrigins() {
  await withServer({ allowedOrigins: 'https://ok.example' }, async ({ url }) => {
    const ok = await openClientWithOptions(url, { headers: { Origin: 'https://ok.example' } });

    await createRoom(ok, 'room-origin', 'create ack');

    try { ok.close(); } catch {}
    await withTimeout(waitForClose(ok), 1000, 'close ok');

    const bad = new WebSocket(url, { headers: { Origin: 'https://bad.example' } });
    const closed = await withTimeout(waitForClose(bad), 2000, 'close bad origin');
    assert.ok(closed.code === 1008 || closed.code === 1006);
  });
}

async function testEnforceSameOrigin() {
  await withServer({ enforceSameOrigin: true }, async ({ url }) => {
    const host = new URL(url).host;
    const sameOrigin = `http://${host}`;

    const ok = await openClientWithOptions(url, { headers: { Origin: sameOrigin } });
    await createRoom(ok, 'room-same-origin', 'same-origin create');

    const noOrigin = new WebSocket(url);
    const noOriginClosed = await withTimeout(waitForClose(noOrigin), 2000, 'same-origin no-origin close');
    assert.ok(noOriginClosed.code === 1008 || noOriginClosed.code === 1006);

    const bad = new WebSocket(url, { headers: { Origin: 'http://evil.example' } });
    const badClosed = await withTimeout(waitForClose(bad), 2000, 'same-origin bad close');
    assert.ok(badClosed.code === 1008 || badClosed.code === 1006);

    try { ok.close(); } catch {}
    await withTimeout(waitForClose(ok), 1000, 'same-origin close ok');
  });
}

async function testLeaveRoomNotifiesPeer() {
  await withServer({}, async ({ server, url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-leave', 'create ack');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-leave', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join ack');
    assert.strictEqual(joined.type, 'room-joined');

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer-joined notify');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    const leftAckP = withTimeout(nextJsonMessage(b), 1000, 'leave ack');
    const peerLeftP = withTimeout(nextJsonMessage(a), 1000, 'peer-left notify');
    b.send(JSON.stringify({ type: 'leave-room' }));

    const [leftAck, peerLeft] = await Promise.all([leftAckP, peerLeftP]);
    assert.strictEqual(leftAck.type, 'room-left');
    assert.strictEqual(peerLeft.type, 'peer-left');
    assert.strictEqual(peerLeft.roomId, 'room-leave');

    // Room should still exist with the creator alone.
    assert.ok(server.rooms.getRoom('room-leave'));

    // Re-join should work after leave.
    const joined2P = withTimeout(nextJsonMessage(b), 1000, 'rejoin ack');
    const peerJoined2P = withTimeout(nextJsonMessage(a), 1000, 'peer-joined notify 2');
    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-leave', roomJoinKey: created.roomJoinKey }));

    const [joined2, peerJoined2] = await Promise.all([joined2P, peerJoined2P]);
    assert.strictEqual(joined2.type, 'room-joined');
    assert.strictEqual(peerJoined2.type, 'peer-joined');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');

    // Room should be destroyed once empty.
    for (let i = 0; i < 50; i++) {
      if (!server.rooms.getRoom('room-leave')) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    assert.strictEqual(server.rooms.getRoom('room-leave'), undefined);
  });
}

async function testWaitingTtlExpiresSoloPeer() {
  await withServer({ waitingTtlMs: 50 }, async ({ url }) => {
    const a = await openClient(url);

    await createRoom(a, 'room-ttl-solo', 'created');

    // Room is a waiting room (1 peer), should expire quickly.
    const closed = await withTimeout(waitForClose(a), 1000, 'ttl close');
    assert.notStrictEqual(closed.code, 0);
  });
}

async function testWaitingTtlDoesNotKillActivePair() {
  await withServer({ waitingTtlMs: 50 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-ttl-pair', 'created');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-ttl-pair', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'joined');
    assert.strictEqual(joined.type, 'room-joined');

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    // Wait beyond TTL; if the timer wasn't disarmed, both would be closed.
    await sleep(120);
    assert.strictEqual(a.readyState, WebSocket.OPEN);
    assert.strictEqual(b.readyState, WebSocket.OPEN);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testMaxPayloadCloses() {
  await withServer({ maxPayloadBytes: 1024 }, async ({ url }) => {
    const a = await openClient(url);

    // Send a huge text frame; server should close with 1009 (too big).
    const big = 'x'.repeat(4096);
    try {
      a.send(big);
    } catch {
      // ignore
    }

    const closed = await withTimeout(waitForClose(a), 2000, 'close big payload');
    assert.ok(closed.code === 1009 || closed.code === 1006 || closed.code === 1008);
  });
}

async function testMaxConnectionsRejectsExcess() {
  await withServer({ maxConnections: 2 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = new WebSocket(url);

    const closed = await withTimeout(waitForClose(c), 2000, 'close excess connection');
    assert.ok(closed.code === 1013 || closed.code === 1006);

    // Existing clients should still function.
    await createRoom(a, 'room-conn-cap', 'create after cap');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testMaxConnectionsPerIpRejectsExcess() {
  await withServer({ maxConnectionsPerIp: 2 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = new WebSocket(url);

    const closed = await withTimeout(waitForClose(c), 2000, 'close excess per-ip connection');
    assert.ok(closed.code === 1013 || closed.code === 1006);

    // Existing clients should still function.
    await createRoom(a, 'room-per-ip-cap', 'create after per-ip cap');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testMessageRateLimitClosesFlood() {
  await withServer({ maxMessagesPerWindow: 5, messageRateWindowMs: 1000 }, async ({ url }) => {
    const a = await openClient(url);

    // Flood with cheap invalid app messages.
    for (let i = 0; i < 16; i++) {
      try { a.send(JSON.stringify({ type: 'unknown' })); } catch {}
    }

    const closed = await withTimeout(waitForClose(a), 2000, 'rate-limit close');
    assert.ok(closed.code === 1008 || closed.code === 1006);
  });
}

async function testPerIpMessageRateLimitAcrossSockets() {
  await withServer({
    maxMessagesPerWindow: 100,
    maxMessagesPerIpPerWindow: 6,
    messageRateWindowMs: 2000,
  }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    for (let i = 0; i < 4; i++) {
      try { a.send(JSON.stringify({ type: 'unknown' })); } catch {}
    }
    for (let i = 0; i < 4; i++) {
      try { b.send(JSON.stringify({ type: 'unknown' })); } catch {}
    }

    const closed = await withTimeout(Promise.race([
      waitForClose(a).then((value) => ({ id: 'a', value })),
      waitForClose(b).then((value) => ({ id: 'b', value })),
    ]), 2000, 'per-ip rate-limit close');

    assert.ok(closed.value.code === 1008 || closed.value.code === 1006);

    if (a.readyState === WebSocket.OPEN) {
      try { a.close(); } catch {}
      await withTimeout(waitForClose(a), 1000, 'close a');
    }
    if (b.readyState === WebSocket.OPEN) {
      try { b.close(); } catch {}
      await withTimeout(waitForClose(b), 1000, 'close b');
    }
  });
}

async function testTrustProxyPerIpControls() {
  await withServer({ maxConnectionsPerIp: 2, trustProxy: true }, async ({ url }) => {
    const localA = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });
    const localB = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });

    const blocked = new WebSocket(url, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
    const blockedClosed = await withTimeout(waitForClose(blocked), 2000, 'trust-proxy per-ip close');
    assert.ok(blockedClosed.code === 1013 || blockedClosed.code === 1006);

    // Different forwarded IP should be admitted.
    const otherIp = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.11' },
    });

    await createRoom(localA, 'room-trust-proxy', 'create trust-proxy room');

    try { localA.close(); } catch {}
    try { localB.close(); } catch {}
    try { otherIp.close(); } catch {}
    await withTimeout(waitForClose(localA), 1000, 'close localA');
    await withTimeout(waitForClose(localB), 1000, 'close localB');
    await withTimeout(waitForClose(otherIp), 1000, 'close otherIp');
  });
}

async function testForwardedForIgnoredWithoutTrustProxy() {
  await withServer({ maxConnectionsPerIp: 1, trustProxy: false }, async ({ url }) => {
    const a = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '198.51.100.1' },
    });

    const b = new WebSocket(url, { headers: { 'X-Forwarded-For': '198.51.100.2' } });
    const closed = await withTimeout(waitForClose(b), 2000, 'forwarded-for ignored close');
    assert.ok(closed.code === 1013 || closed.code === 1006);

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testRoomOpsBudgetAndCooldown() {
  await withServer({
    maxRoomOpsPerIpPerWindow: 3,
    roomOpsWindowMs: 5000,
    roomOpsCooldownMs: 200,
  }, async ({ url }) => {
    const a = await openClient(url);

    for (let i = 0; i < 3; i++) {
      a.send(JSON.stringify({ type: 'join-room', roomId: `room-miss-${i}` }));
      const err = await withTimeout(nextJsonMessage(a), 1000, `room-op miss ${i}`);
      assert.strictEqual(err.type, 'error');
      assert.strictEqual(err.message, 'Join unavailable');
    }

    a.send(JSON.stringify({ type: 'join-room', roomId: 'room-miss-throttled' }));
    const throttled = await withTimeout(nextJsonMessage(a), 1000, 'room-op throttled');
    assert.strictEqual(throttled.type, 'error');
    assert.strictEqual(throttled.message, 'Too many room operations; retry later');
    assert.ok(Number.isFinite(throttled.retryAfterMs));
    assert.ok(throttled.retryAfterMs >= 1);

    await sleep(250);

    a.send(JSON.stringify({ type: 'join-room', roomId: 'room-miss-after-cooldown' }));
    const afterCooldown = await withTimeout(nextJsonMessage(a), 1000, 'room-op after cooldown');
    assert.strictEqual(afterCooldown.type, 'error');
    assert.strictEqual(afterCooldown.message, 'Join unavailable');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testRoomOpsBudgetUsesTrustProxy() {
  await withServer({
    maxRoomOpsPerIpPerWindow: 1,
    roomOpsWindowMs: 5000,
    roomOpsCooldownMs: 200,
    trustProxy: true,
  }, async ({ url }) => {
    const a = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.44' },
    });
    const b = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.45' },
    });

    a.send(JSON.stringify({ type: 'join-room', roomId: 'room-proxy-a-1' }));
    const aFirst = await withTimeout(nextJsonMessage(a), 1000, 'proxy a first');
    assert.strictEqual(aFirst.type, 'error');
    assert.strictEqual(aFirst.message, 'Join unavailable');

    a.send(JSON.stringify({ type: 'join-room', roomId: 'room-proxy-a-2' }));
    const aSecond = await withTimeout(nextJsonMessage(a), 1000, 'proxy a second');
    assert.strictEqual(aSecond.type, 'error');
    assert.strictEqual(aSecond.message, 'Too many room operations; retry later');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-proxy-b-1' }));
    const bFirst = await withTimeout(nextJsonMessage(b), 1000, 'proxy b first');
    assert.strictEqual(bFirst.type, 'error');
    assert.strictEqual(bFirst.message, 'Join unavailable');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testJoinUnavailableShaping() {
  await withServer({ joinDenyDelayMs: 40 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = await openClient(url);
    const d = await openClient(url);

    const missStart = Date.now();
    a.send(JSON.stringify({ type: 'join-room', roomId: 'room-shaped-miss' }));
    const miss = await withTimeout(nextJsonMessage(a), 1000, 'join miss shaped');
    const missElapsedMs = Date.now() - missStart;
    assert.strictEqual(miss.type, 'error');
    assert.strictEqual(miss.message, 'Join unavailable');
    assert.ok(missElapsedMs >= 25);

    const created = await createRoom(b, 'room-shaped-full', 'create shaped room');

    c.send(JSON.stringify({ type: 'join-room', roomId: 'room-shaped-full', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(c), 1000, 'join shaped room');
    assert.strictEqual(joined.type, 'room-joined');

    const peerJoined = await withTimeout(nextJsonMessage(b), 1000, 'peer joined shaped room');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    const fullStart = Date.now();
    d.send(JSON.stringify({ type: 'join-room', roomId: 'room-shaped-full', roomJoinKey: created.roomJoinKey }));
    const full = await withTimeout(nextJsonMessage(d), 1000, 'join full shaped');
    const fullElapsedMs = Date.now() - fullStart;
    assert.strictEqual(full.type, 'error');
    assert.strictEqual(full.message, 'Join unavailable');
    assert.ok(fullElapsedMs >= 25);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    try { c.close(); } catch {}
    try { d.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
    await withTimeout(waitForClose(c), 1000, 'close c');
    await withTimeout(waitForClose(d), 1000, 'close d');
  });
}

async function testRoomJoinKeyAuth() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = await openClient(url);

    const created = await createRoom(a, 'room-auth-required', 'create auth room');
    assert.strictEqual(typeof created.roomJoinKey, 'string');

    // Missing key fails closed.
    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-auth-required' }));
    const missing = await withTimeout(nextJsonMessage(b), 1000, 'join missing key');
    assert.strictEqual(missing.type, 'error');
    assert.strictEqual(missing.message, 'Join unavailable');

    // Wrong key also fails closed.
    c.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-auth-required',
      roomJoinKey: makeRoomJoinKey('wrong'),
    }));
    const wrong = await withTimeout(nextJsonMessage(c), 1000, 'join wrong key');
    assert.strictEqual(wrong.type, 'error');
    assert.strictEqual(wrong.message, 'Join unavailable');

    // Correct key succeeds.
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-auth-required',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join correct key');
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(joined.roomJoinKey, created.roomJoinKey);

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined auth room');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    try { c.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
    await withTimeout(waitForClose(c), 1000, 'close c');
  });
}

async function testCreateRoomAcceptsCustomJoinKey() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const customKey = makeRoomJoinKey('custom');

    const created = await createRoom(a, 'room-custom-key', 'create custom key', customKey);
    assert.strictEqual(created.roomJoinKey, customKey);

    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-custom-key',
      roomJoinKey: customKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join custom key');
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(joined.roomJoinKey, customKey);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testPeerIdentityAndOwnerContract() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-owner-contract', 'create owner contract');
    assert.strictEqual(typeof created.peerId, 'string');
    assert.strictEqual(created.roomOwnerPeerId, created.peerId);
    assert.strictEqual(created.role, 'owner');

    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-owner-contract',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join owner contract');
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(typeof joined.peerId, 'string');
    assert.notStrictEqual(joined.peerId, created.peerId);
    assert.strictEqual(joined.roomOwnerPeerId, created.peerId);
    assert.strictEqual(joined.role, 'peer');

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined owner contract');
    assert.strictEqual(peerJoined.type, 'peer-joined');
    assert.strictEqual(peerJoined.peerId, joined.peerId);
    assert.strictEqual(peerJoined.roomOwnerPeerId, created.peerId);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testOwnerOnlyRotateRoomJoinKey() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = await openClient(url);

    const created = await createRoom(a, 'room-rotate-key', 'create rotate room');
    const oldKey = created.roomJoinKey;

    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-rotate-key',
      roomJoinKey: oldKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join rotate room');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined rotate room');

    b.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const nonOwnerErr = await withTimeout(nextJsonMessage(b), 1000, 'non-owner rotate denied');
    assert.strictEqual(nonOwnerErr.type, 'error');
    assert.strictEqual(nonOwnerErr.message, 'Owner privileges required');

    const rotateAckA = withTimeout(nextJsonMessage(a), 1000, 'owner rotate ack a');
    const rotateAckB = withTimeout(nextJsonMessage(b), 1000, 'owner rotate ack b');
    a.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const [rotA, rotB] = await Promise.all([rotateAckA, rotateAckB]);

    assert.strictEqual(rotA.type, 'room-key-rotated');
    assert.strictEqual(rotB.type, 'room-key-rotated');
    assert.strictEqual(rotA.roomId, 'room-rotate-key');
    assert.strictEqual(rotA.roomJoinKey, rotB.roomJoinKey);
    assert.notStrictEqual(rotA.roomJoinKey, oldKey);
    assert.strictEqual(rotA.roomOwnerPeerId, created.peerId);
    assert.strictEqual(rotA.rotatedByPeerId, created.peerId);

    c.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-rotate-key',
      roomJoinKey: oldKey,
    }));
    const oldKeyDenied = await withTimeout(nextJsonMessage(c), 1000, 'old key denied');
    assert.strictEqual(oldKeyDenied.type, 'error');
    assert.strictEqual(oldKeyDenied.message, 'Join unavailable');

    c.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-rotate-key',
      roomJoinKey: rotA.roomJoinKey,
    }));
    const newKeyDenied = await withTimeout(nextJsonMessage(c), 1000, 'new key denied because full');
    assert.strictEqual(newKeyDenied.type, 'error');
    assert.strictEqual(newKeyDenied.message, 'Join unavailable');

    const peerLeftP = withTimeout(nextJsonMessage(a), 1000, 'peer left after closing b');
    const closeB = withTimeout(waitForClose(b), 1000, 'close b for reopen');
    try { b.close(); } catch {}
    const [, peerLeft] = await Promise.all([closeB, peerLeftP]);
    assert.strictEqual(peerLeft.type, 'peer-left');
    assert.strictEqual(peerLeft.peerId, joined.peerId);

    c.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-rotate-key',
      roomJoinKey: rotA.roomJoinKey,
    }));
    const newKeyAccepted = await withTimeout(nextJsonMessage(c), 1000, 'new key accepted');
    assert.strictEqual(newKeyAccepted.type, 'room-joined');
    assert.strictEqual(newKeyAccepted.roomJoinKey, rotA.roomJoinKey);

    try { a.close(); } catch {}
    try { c.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(c), 1000, 'close c');
  });
}

async function testOwnerTransferAfterOwnerLeaves() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-owner-transfer', 'create owner transfer');
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-owner-transfer',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join owner transfer');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined owner transfer');

    const leftAckP = withTimeout(nextJsonMessage(a), 1000, 'owner leave ack');
    const bEventsP = withTimeout(nextNJsonMessages(b, 2), 1000, 'owner transfer events');
    a.send(JSON.stringify({ type: 'leave-room' }));
    const leftAck = await leftAckP;
    const bEvents = await bEventsP;
    const peerLeft = bEvents.find((m) => m && m.type === 'peer-left');
    const ownerChanged = bEvents.find((m) => m && m.type === 'room-owner-changed');
    assert.strictEqual(leftAck.type, 'room-left');
    assert.ok(peerLeft);
    assert.strictEqual(peerLeft.peerId, created.peerId);
    assert.ok(ownerChanged);
    assert.strictEqual(ownerChanged.roomOwnerPeerId, joined.peerId);

    b.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const rotateB = await withTimeout(nextJsonMessage(b), 1000, 'new owner rotate ack');
    assert.strictEqual(rotateB.type, 'room-key-rotated');
    assert.strictEqual(rotateB.rotatedByPeerId, joined.peerId);
    assert.strictEqual(rotateB.roomOwnerPeerId, joined.peerId);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testOwnerTransferAfterOwnerDisconnects() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-owner-disconnect-transfer', 'create owner disconnect transfer');
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-owner-disconnect-transfer',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join owner disconnect transfer');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined owner disconnect transfer');

    const transferEventsP = withTimeout(nextNJsonMessages(b, 2), 1000, 'owner disconnect transfer events');
    const closeA = withTimeout(waitForClose(a), 1000, 'close owner socket');
    try { a.close(); } catch {}
    await closeA;

    const transferEvents = await transferEventsP;
    const peerLeft = transferEvents.find((m) => m && m.type === 'peer-left');
    const ownerChanged = transferEvents.find((m) => m && m.type === 'room-owner-changed');
    assert.ok(peerLeft);
    assert.ok(ownerChanged);
    assert.strictEqual(peerLeft.peerId, created.peerId);
    assert.strictEqual(ownerChanged.roomOwnerPeerId, joined.peerId);

    b.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const rotateB = await withTimeout(nextJsonMessage(b), 1000, 'new owner rotate after disconnect');
    assert.strictEqual(rotateB.type, 'room-key-rotated');
    assert.strictEqual(rotateB.rotatedByPeerId, joined.peerId);
    assert.strictEqual(rotateB.roomOwnerPeerId, joined.peerId);

    try { b.close(); } catch {}
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testOwnerOpsBudgetAndCooldown() {
  await withServer({
    maxOwnerOpsPerIpPerWindow: 1,
    ownerOpsWindowMs: 5000,
    ownerOpsCooldownMs: 200,
  }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-owner-op-budget', 'create owner op budget');
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-owner-op-budget',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join owner op budget');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined owner op budget');

    const rot1A = withTimeout(nextJsonMessage(a), 1000, 'owner rotate 1 ack a');
    const rot1B = withTimeout(nextJsonMessage(b), 1000, 'owner rotate 1 ack b');
    a.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const [rotate1A, rotate1B] = await Promise.all([rot1A, rot1B]);
    assert.strictEqual(rotate1A.type, 'room-key-rotated');
    assert.strictEqual(rotate1B.type, 'room-key-rotated');

    a.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const throttled = await withTimeout(nextJsonMessage(a), 1000, 'owner rotate throttled');
    assert.strictEqual(throttled.type, 'error');
    assert.strictEqual(throttled.message, 'Too many owner operations; retry later');
    assert.ok(Number.isFinite(throttled.retryAfterMs));
    assert.ok(throttled.retryAfterMs >= 1);

    await sleep(250);

    const rot2A = withTimeout(nextJsonMessage(a), 1000, 'owner rotate 2 ack a');
    const rot2B = withTimeout(nextJsonMessage(b), 1000, 'owner rotate 2 ack b');
    a.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const [rotate2A, rotate2B] = await Promise.all([rot2A, rot2B]);
    assert.strictEqual(rotate2A.type, 'room-key-rotated');
    assert.strictEqual(rotate2B.type, 'room-key-rotated');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testOwnerOpsBudgetBlocksNonOwnerAbuseWithTrustProxy() {
  await withServer({
    trustProxy: true,
    maxOwnerOpsPerIpPerWindow: 1,
    ownerOpsWindowMs: 5000,
    ownerOpsCooldownMs: 200,
  }, async ({ url }) => {
    const a = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.41' },
    });
    const b = await openClientWithOptions(url, {
      headers: { 'X-Forwarded-For': '203.0.113.42' },
    });

    const created = await createRoom(a, 'room-owner-abuse-budget', 'create owner abuse budget');
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-owner-abuse-budget',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join owner abuse budget');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined owner abuse budget');

    b.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const nonOwnerDenied = await withTimeout(nextJsonMessage(b), 1000, 'non-owner rotate denied');
    assert.strictEqual(nonOwnerDenied.type, 'error');
    assert.strictEqual(nonOwnerDenied.message, 'Owner privileges required');

    b.send(JSON.stringify({ type: 'close-room' }));
    const nonOwnerThrottled = await withTimeout(nextJsonMessage(b), 1000, 'non-owner owner-op throttled');
    assert.strictEqual(nonOwnerThrottled.type, 'error');
    assert.strictEqual(nonOwnerThrottled.message, 'Too many owner operations; retry later');

    const rotateOwnerA = withTimeout(nextJsonMessage(a), 1000, 'owner rotate allowed a');
    const rotateOwnerB = withTimeout(nextJsonMessage(b), 1000, 'owner rotate allowed b');
    a.send(JSON.stringify({ type: 'rotate-room-join-key' }));
    const [ownerRotA, ownerRotB] = await Promise.all([rotateOwnerA, rotateOwnerB]);
    assert.strictEqual(ownerRotA.type, 'room-key-rotated');
    assert.strictEqual(ownerRotB.type, 'room-key-rotated');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function testOwnerCloseBudgetAndCooldown() {
  await withServer({
    maxOwnerOpsPerIpPerWindow: 1,
    ownerOpsWindowMs: 5000,
    ownerOpsCooldownMs: 200,
  }, async ({ url }) => {
    const a = await openClient(url);

    await createRoom(a, 'room-owner-close-budget-1', 'create owner close budget 1');
    a.send(JSON.stringify({ type: 'close-room' }));
    const closed1 = await withTimeout(nextJsonMessage(a), 1000, 'close room 1');
    assert.strictEqual(closed1.type, 'room-closed');

    await createRoom(a, 'room-owner-close-budget-2', 'create owner close budget 2');
    a.send(JSON.stringify({ type: 'close-room' }));
    const throttled = await withTimeout(nextJsonMessage(a), 1000, 'close room throttled');
    assert.strictEqual(throttled.type, 'error');
    assert.strictEqual(throttled.message, 'Too many owner operations; retry later');

    await sleep(250);

    a.send(JSON.stringify({ type: 'close-room' }));
    const closed2 = await withTimeout(nextJsonMessage(a), 1000, 'close room 2 after cooldown');
    assert.strictEqual(closed2.type, 'room-closed');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
  });
}

async function testOwnerOnlyCloseRoom() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);
    const c = await openClient(url);

    const created = await createRoom(a, 'room-close-owner', 'create close room');
    b.send(JSON.stringify({
      type: 'join-room',
      roomId: 'room-close-owner',
      roomJoinKey: created.roomJoinKey,
    }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join close room');
    assert.strictEqual(joined.type, 'room-joined');
    await withTimeout(nextJsonMessage(a), 1000, 'peer joined close room');

    b.send(JSON.stringify({ type: 'close-room' }));
    const denied = await withTimeout(nextJsonMessage(b), 1000, 'close denied');
    assert.strictEqual(denied.type, 'error');
    assert.strictEqual(denied.message, 'Owner privileges required');

    const closedA = withTimeout(nextJsonMessage(a), 1000, 'closed a');
    const closedB = withTimeout(nextJsonMessage(b), 1000, 'closed b');
    a.send(JSON.stringify({ type: 'close-room' }));
    const [roomClosedA, roomClosedB] = await Promise.all([closedA, closedB]);
    assert.strictEqual(roomClosedA.type, 'room-closed');
    assert.strictEqual(roomClosedB.type, 'room-closed');
    assert.strictEqual(roomClosedA.closedByPeerId, created.peerId);

    // Room can be recreated after close.
    c.send(JSON.stringify({ type: 'create-room', roomId: 'room-close-owner' }));
    const recreated = await withTimeout(nextJsonMessage(c), 1000, 'recreate after close');
    assert.strictEqual(recreated.type, 'room-created');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    try { c.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
    await withTimeout(waitForClose(c), 1000, 'close c');
  });
}

async function testMaxRoomsRejectsCreateWhenServerBusy() {
  await withServer({ maxRooms: 1 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    const created = await createRoom(a, 'room-cap-a', 'create room a');

    b.send(JSON.stringify({ type: 'create-room', roomId: 'room-cap-b' }));
    const err = await withTimeout(nextJsonMessage(b), 1000, 'server busy');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Server busy');

    // Joining existing room should still work under room-cap.
    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-cap-a', roomJoinKey: created.roomJoinKey }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join room a');
    assert.strictEqual(joined.type, 'room-joined');

    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  });
}

async function runSignalingTestSuite() {
  // Keep output terse; failures will throw.
  await testRelaySignal();
  await testRoomFull();
  await testCreateRoomCollision();
  await testInvalidRoomId();
  await testInvalidRoomJoinKey();
  await testSignalWithoutRoom();
  await testAllowedOrigins();
  await testEnforceSameOrigin();
  await testLeaveRoomNotifiesPeer();
  await testWaitingTtlExpiresSoloPeer();
  await testWaitingTtlDoesNotKillActivePair();
  await testMaxPayloadCloses();
  await testMaxConnectionsRejectsExcess();
  await testMaxConnectionsPerIpRejectsExcess();
  await testMessageRateLimitClosesFlood();
  await testPerIpMessageRateLimitAcrossSockets();
  await testTrustProxyPerIpControls();
  await testForwardedForIgnoredWithoutTrustProxy();
  await testRoomOpsBudgetAndCooldown();
  await testRoomOpsBudgetUsesTrustProxy();
  await testJoinUnavailableShaping();
  await testRoomJoinKeyAuth();
  await testCreateRoomAcceptsCustomJoinKey();
  await testPeerIdentityAndOwnerContract();
  await testOwnerOnlyRotateRoomJoinKey();
  await testOwnerOpsBudgetAndCooldown();
  await testOwnerOpsBudgetBlocksNonOwnerAbuseWithTrustProxy();
  await testOwnerCloseBudgetAndCooldown();
  await testOwnerTransferAfterOwnerLeaves();
  await testOwnerTransferAfterOwnerDisconnects();
  await testOwnerOnlyCloseRoom();
  await testMaxRoomsRejectsCreateWhenServerBusy();
}

module.exports = {
  runSignalingTestSuite,
};
