const assert = require('assert');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVE_ENTRY = path.join(__dirname, '..', 'serve.js');

function withTimeout(promise, timeoutMs, label = 'timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), timeoutMs)),
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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: pathname,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startAppServer(extraEnv = null) {
  const port = await getFreePort();
  const out = [];
  const err = [];

  const proc = spawn(process.execPath, [SERVE_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      VERBOSE: '0',
      ICE_SERVERS_JSON: '',
      ICE_TRANSPORT_POLICY: '',
      TURN_URLS_JSON: '',
      TURN_AUTH_SECRET: '',
      TURN_TTL_SECONDS: '',
      ENFORCE_SAME_ORIGIN: '',
      ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
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

  const first = await Promise.race([exited, ready]);
  if (typeof first === 'number') {
    const msg = [
      `App server exited early with code ${first}.`,
      out.length ? `stdout:\n${out.join('')}` : '',
      err.length ? `stderr:\n${err.join('')}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(msg);
  }

  async function stop() {
    if (proc.exitCode !== null) return;
    try { proc.kill('SIGINT'); } catch {}
    try {
      await withTimeout(exited, 5000, 'app server SIGINT timeout');
      return;
    } catch {}

    try { proc.kill('SIGKILL'); } catch {}
    await withTimeout(exited, 2000, 'app server SIGKILL timeout');
  }

  return { port, proc, stop };
}

async function assertStartFails(extraEnv = null) {
  let failed = false;
  try {
    const app = await startAppServer(extraEnv);
    await app.stop();
  } catch (err) {
    failed = true;
    assert.ok(String(err && err.message).includes('exited early'));
  }
  assert.strictEqual(failed, true);
}

function openClientRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
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

function originFromWsUrl(url) {
  const parsed = new URL(url);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${parsed.host}`;
}

function openClient(url, options = {}) {
  const headers = {
    ...(options && options.headers ? options.headers : {}),
  };
  if (!Object.prototype.hasOwnProperty.call(headers, 'Origin') && !Object.prototype.hasOwnProperty.call(headers, 'origin')) {
    headers.Origin = originFromWsUrl(url);
  }

  return openClientRaw(url, {
    ...options,
    headers,
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

async function testStaticHeadersAndPathGuards() {
  const app = await startAppServer();
  try {
    const index = await httpGet(app.port, '/');
    assert.strictEqual(index.status, 200);
    assert.ok((index.headers['content-type'] || '').includes('text/html'));
    assert.strictEqual(index.headers['cache-control'], 'no-store');
    assert.strictEqual(index.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(index.headers['referrer-policy'], 'no-referrer');

    const csp = String(index.headers['content-security-policy'] || '');
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("connect-src 'self' ws: wss:"));

    const missing = await httpGet(app.port, '/does-not-exist.js');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.headers['cache-control'], 'no-store');
    assert.strictEqual(missing.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(missing.headers['referrer-policy'], 'no-referrer');

    const traversal = await httpGet(app.port, '/%2e%2e/%2e%2e/etc/passwd');
    // Depending on path normalization details this can be rejected as 400
    // or normalized to a missing in-root path as 404. Either is safe.
    assert.ok(traversal.status === 400 || traversal.status === 404);
    assert.strictEqual(traversal.headers['cache-control'], 'no-store');
    assert.strictEqual(traversal.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(traversal.headers['referrer-policy'], 'no-referrer');
  } finally {
    await app.stop();
  }
}

async function testSameOriginSignalingOverAppServer() {
  const app = await startAppServer();
  const url = `ws://127.0.0.1:${app.port}`;

  try {
    const a = await openClient(url);
    const b = await openClient(url);

    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-app-server' }));
    const created = await withTimeout(nextJsonMessage(a), 2000, 'create ack');
    assert.strictEqual(created.type, 'room-created');
    assert.strictEqual(created.peerCount, 1);

    b.send(JSON.stringify({ type: 'join-room', roomId: 'room-app-server' }));
    const joined = await withTimeout(nextJsonMessage(b), 2000, 'join ack');
    assert.strictEqual(joined.type, 'room-joined');
    assert.strictEqual(joined.peerCount, 2);

    const peerJoined = await withTimeout(nextJsonMessage(a), 2000, 'peer joined notify');
    assert.strictEqual(peerJoined.type, 'peer-joined');

    a.send(JSON.stringify({ type: 'signal', payload: { sdp: 'fake-offer' } }));
    const relayed = await withTimeout(nextJsonMessage(b), 2000, 'signal relay');
    assert.strictEqual(relayed.type, 'signal');
    assert.deepStrictEqual(relayed.payload, { sdp: 'fake-offer' });

    try { a.close(); } catch {}
    try { b.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'close a');
    await withTimeout(waitForClose(b), 1000, 'close b');
  } finally {
    await app.stop();
  }
}

async function testDefaultSameOriginPolicyOnAppServer() {
  const app = await startAppServer();
  const url = `ws://127.0.0.1:${app.port}`;

  try {
    const noOrigin = new WebSocket(url);
    const noOriginClosed = await withTimeout(waitForClose(noOrigin), 2000, 'app-server no-origin close');
    assert.ok(noOriginClosed.code === 1008 || noOriginClosed.code === 1006);

    const bad = new WebSocket(url, { headers: { Origin: 'http://evil.example' } });
    const badClosed = await withTimeout(waitForClose(bad), 2000, 'app-server bad-origin close');
    assert.ok(badClosed.code === 1008 || badClosed.code === 1006);

    const ok = await openClient(url);
    ok.send(JSON.stringify({ type: 'create-room', roomId: 'room-origin-policy' }));
    const created = await withTimeout(nextJsonMessage(ok), 1000, 'origin-policy create');
    assert.strictEqual(created.type, 'room-created');
    try { ok.close(); } catch {}
    await withTimeout(waitForClose(ok), 1000, 'origin-policy close');
  } finally {
    await app.stop();
  }
}

async function testDisableSameOriginPolicyOverride() {
  const app = await startAppServer({ ENFORCE_SAME_ORIGIN: '0' });
  const url = `ws://127.0.0.1:${app.port}`;

  try {
    const a = await openClientRaw(url);
    a.send(JSON.stringify({ type: 'create-room', roomId: 'room-origin-override' }));
    const created = await withTimeout(nextJsonMessage(a), 1000, 'origin-override create');
    assert.strictEqual(created.type, 'room-created');

    try { a.close(); } catch {}
    await withTimeout(waitForClose(a), 1000, 'origin-override close');
  } finally {
    await app.stop();
  }
}

async function testHealthAndRuntimeConfigEndpoints() {
  const app = await startAppServer({
    ICE_SERVERS_JSON: JSON.stringify([
      { urls: 'stun:stun.example.net:3478' },
      {
        urls: ['turn:turn.example.net:3478', 'turns:turn.example.net:5349'],
        username: 'alpha-user',
        credential: 'alpha-pass',
      },
    ]),
    ICE_TRANSPORT_POLICY: 'relay',
  });

  try {
    const health = await httpGet(app.port, '/healthz');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.headers['cache-control'], 'no-store');
    assert.strictEqual(health.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(health.headers['referrer-policy'], 'no-referrer');
    assert.ok((health.headers['content-type'] || '').includes('application/json'));

    const healthObj = JSON.parse(health.body || '{}');
    assert.strictEqual(healthObj.ok, true);
    assert.strictEqual(healthObj.service, 'ephera-app');

    const ready = await httpGet(app.port, '/readyz');
    assert.strictEqual(ready.status, 200);
    assert.ok((ready.headers['content-type'] || '').includes('application/json'));
    const readyObj = JSON.parse(ready.body || '{}');
    assert.strictEqual(readyObj.ok, true);
    assert.strictEqual(readyObj.signalingReady, true);
    assert.strictEqual(readyObj.stopping, false);

    const runtime = await httpGet(app.port, '/runtime-config');
    assert.strictEqual(runtime.status, 200);
    assert.strictEqual(runtime.headers['cache-control'], 'no-store');
    assert.strictEqual(runtime.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(runtime.headers['referrer-policy'], 'no-referrer');
    assert.ok((runtime.headers['content-type'] || '').includes('application/json'));

    const runtimeObj = JSON.parse(runtime.body || '{}');
    assert.strictEqual(runtimeObj.v, 1);
    assert.strictEqual(runtimeObj.icePolicy, 'relay');
    assert.ok(Array.isArray(runtimeObj.iceServers));
    assert.strictEqual(runtimeObj.iceServers.length, 2);
    assert.strictEqual(runtimeObj.iceServers[0].urls, 'stun:stun.example.net:3478');
    assert.deepStrictEqual(runtimeObj.iceServers[1].urls, [
      'turn:turn.example.net:3478',
      'turns:turn.example.net:5349',
    ]);
    assert.strictEqual(runtimeObj.iceServers[1].username, 'alpha-user');
    assert.strictEqual(runtimeObj.iceServers[1].credential, 'alpha-pass');
  } finally {
    await app.stop();
  }
}

async function testRuntimeConfigDynamicTurnCredentials() {
  const turnSecret = 'turn-shared-secret-alpha';
  const ttlSeconds = 120;
  const app = await startAppServer({
    ICE_SERVERS_JSON: JSON.stringify([
      { urls: 'stun:stun.example.net:3478' },
    ]),
    TURN_URLS_JSON: JSON.stringify([
      'turn:turn.example.net:3478?transport=udp',
      'turns:turn.example.net:5349?transport=tcp',
    ]),
    TURN_AUTH_SECRET: turnSecret,
    TURN_TTL_SECONDS: String(ttlSeconds),
    ICE_TRANSPORT_POLICY: 'relay',
  });

  try {
    const first = await httpGet(app.port, '/runtime-config');
    const second = await httpGet(app.port, '/runtime-config');

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);

    const cfgA = JSON.parse(first.body || '{}');
    const cfgB = JSON.parse(second.body || '{}');

    assert.strictEqual(cfgA.v, 1);
    assert.strictEqual(cfgA.icePolicy, 'relay');
    assert.ok(Array.isArray(cfgA.iceServers));
    assert.strictEqual(cfgA.iceServers.length, 2);
    assert.strictEqual(cfgA.iceServers[0].urls, 'stun:stun.example.net:3478');

    const turnA = cfgA.iceServers[1];
    const turnB = cfgB.iceServers[1];
    assert.deepStrictEqual(turnA.urls, [
      'turn:turn.example.net:3478?transport=udp',
      'turns:turn.example.net:5349?transport=tcp',
    ]);

    assert.ok(typeof turnA.username === 'string');
    assert.ok(/^\d+:[0-9a-f]{16}$/.test(turnA.username));

    const expectedCredA = crypto.createHmac('sha1', turnSecret).update(turnA.username).digest('base64');
    assert.strictEqual(turnA.credential, expectedCredA);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresA = Number(turnA.username.split(':')[0]);
    assert.ok(Number.isFinite(expiresA));
    assert.ok(expiresA >= (nowSeconds + ttlSeconds - 3));
    assert.ok(expiresA <= (nowSeconds + ttlSeconds + 3));

    // Fresh runtime-config calls should rotate username/credential.
    assert.notStrictEqual(turnB.username, turnA.username);
    assert.notStrictEqual(turnB.credential, turnA.credential);
    const expectedCredB = crypto.createHmac('sha1', turnSecret).update(turnB.username).digest('base64');
    assert.strictEqual(turnB.credential, expectedCredB);
  } finally {
    await app.stop();
  }
}

async function testInvalidDynamicTurnEnvFailsFast() {
  await assertStartFails({
    TURN_AUTH_SECRET: 'secret-only',
  });

  await assertStartFails({
    TURN_URLS_JSON: JSON.stringify(['turn:turn.example.net:3478']),
  });

  await assertStartFails({
    TURN_URLS_JSON: JSON.stringify(['turn:turn.example.net:3478']),
    TURN_AUTH_SECRET: 'secret',
    TURN_TTL_SECONDS: '10',
  });

  await assertStartFails({
    TURN_URLS_JSON: JSON.stringify(['stun:stun.example.net:3478']),
    TURN_AUTH_SECRET: 'secret',
  });
}

async function runServeTestSuite() {
  await testStaticHeadersAndPathGuards();
  await testDefaultSameOriginPolicyOnAppServer();
  await testDisableSameOriginPolicyOverride();
  await testHealthAndRuntimeConfigEndpoints();
  await testRuntimeConfigDynamicTurnCredentials();
  await testInvalidDynamicTurnEnvFailsFast();
  await testSameOriginSignalingOverAppServer();
}

module.exports = {
  runServeTestSuite,
};
