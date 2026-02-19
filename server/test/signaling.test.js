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

async function testRelaySignal() {
  await withServer({}, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-relay' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'create-room ack');
    assert.strictEqual(created.type, 'room-created');
    assert.strictEqual(created.roomId, 'room-relay');
    assert.strictEqual(created.peerCount, 1);

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-relay' }));
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

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-full' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'create ack');
    assert.strictEqual(created.type, 'room-created');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-full' }));
    const joined = await withTimeout(nextJsonMessage(b), 1000, 'join ack');
    assert.strictEqual(joined.type, 'room-joined');

    // a receives peer-joined
    const peerJoined = await withTimeout(nextJsonMessage(a), 1000, 'peer joined');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    c.send(JSON.stringify({ type: 'join-room', roomId: 'room-full' }));
    const err = await withTimeout(nextJsonMessage(c), 1000, 'room full error');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Room full');

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

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-collide' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'created');
    assert.strictEqual(created.type, 'room-created');

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

    ok.send(JSON.stringify({ type: 'create-room', roomId: 'room-origin' }));
    const created = await withTimeout(nextJsonMessage(ok), 1000, 'create ack');
    assert.strictEqual(created.type, 'room-created');

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
    ok.send(JSON.stringify({ type: 'create-room', roomId: 'room-same-origin' }));
    const created = await withTimeout(nextJsonMessage(ok), 1000, 'same-origin create');
    assert.strictEqual(created.type, 'room-created');

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

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-leave' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'create ack');
    assert.strictEqual(created.type, 'room-created');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-leave' }));
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
    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-leave' }));

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

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-ttl-solo' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'created');
    assert.strictEqual(created.type, 'room-created');

    // Room is a waiting room (1 peer), should expire quickly.
    const closed = await withTimeout(waitForClose(a), 1000, 'ttl close');
    assert.notStrictEqual(closed.code, 0);
  });
}

async function testWaitingTtlDoesNotKillActivePair() {
  await withServer({ waitingTtlMs: 50 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-ttl-pair' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'created');
    assert.strictEqual(created.type, 'room-created');

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-ttl-pair' }));
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
    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-conn-cap' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'create after cap');
    assert.strictEqual(created.type, 'room-created');

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

async function testMaxRoomsRejectsCreateWhenServerBusy() {
  await withServer({ maxRooms: 1 }, async ({ url }) => {
    const a = await openClient(url);
    const b = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-cap-a' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'create room a');
    assert.strictEqual(created.type, 'room-created');

    b.send(JSON.stringify({ type: 'create-room', roomId: 'room-cap-b' }));
    const err = await withTimeout(nextJsonMessage(b), 1000, 'server busy');
    assert.strictEqual(err.type, 'error');
    assert.strictEqual(err.message, 'Server busy');

    // Joining existing room should still work under room-cap.
    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-cap-a' }));
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
  await testSignalWithoutRoom();
  await testAllowedOrigins();
  await testEnforceSameOrigin();
  await testLeaveRoomNotifiesPeer();
  await testWaitingTtlExpiresSoloPeer();
  await testWaitingTtlDoesNotKillActivePair();
  await testMaxPayloadCloses();
  await testMaxConnectionsRejectsExcess();
  await testMessageRateLimitClosesFlood();
  await testMaxRoomsRejectsCreateWhenServerBusy();
}

module.exports = {
  runSignalingTestSuite,
};
