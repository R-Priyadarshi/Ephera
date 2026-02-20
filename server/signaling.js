/**
 * EPHERA — Stateless Signaling Server (Module)
 *
 * This module is testable and does not attach process signal handlers.
 * The CLI entrypoint lives in server/index.js.
 *
 * ZERO-MEMORY GUARANTEES:
 * - No disk writes
 * - No persistent logs
 * - No payload inspection beyond minimal validation/caps
 * - No recovery
 * - All state lives only in RAM
 * - Process death = total amnesia
 */

const { WebSocketServer } = require('ws');
const { createRoomStore } = require('./rooms');

const DEFAULT_MAX_PEERS_PER_ROOM = 2;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024; // signaling-only; must still allow SDP + ICE
const DEFAULT_PING_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_CONNECTIONS = 2048;
const DEFAULT_MAX_ROOMS = 4096;
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 240;
const DEFAULT_MESSAGE_RATE_WINDOW_MS = 10 * 1000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 64;
const DEFAULT_MAX_MESSAGES_PER_IP_PER_WINDOW = 1200;
const DEFAULT_MAX_ROOM_OPS_PER_IP_PER_WINDOW = 120;
const DEFAULT_ROOM_OPS_WINDOW_MS = 60 * 1000;
const DEFAULT_ROOM_OPS_COOLDOWN_MS = 30 * 1000;

function parseAllowedOrigins(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw === '*') return { any: true, set: null };

  const set = new Set();
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (s) set.add(s);
  }
  if (set.size === 0) return null;
  return { any: false, set };
}

function sanitizeRoomId(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  // Avoid path/space weirdness; keep ids URL-safe and compact.
  // Allows: letters, digits, underscore, hyphen. Must start with alnum.
  if (s.length > 96) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)) return null;
  return s;
}

function byteLengthUtf8(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function safeSend(socket, obj) {
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(obj));
  } catch {
    // intentionally silent
  }
}

function parsePositiveInt(value, fallback, min = 1) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function parseBooleanFlag(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const s = value.trim().toLowerCase();
  if (!s) return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  let ip = value.trim();
  if (!ip) return '';
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  return ip;
}

function firstForwardedFor(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const raw = headers['x-forwarded-for'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const first = item.split(',')[0].trim();
      if (first) return first;
    }
    return '';
  }
  if (typeof raw === 'string') return raw.split(',')[0].trim();
  return '';
}

function getClientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = normalizeIp(firstForwardedFor(req && req.headers ? req.headers : null));
    if (forwarded) return forwarded;
  }

  const remote = normalizeIp(req && req.socket && typeof req.socket.remoteAddress === 'string'
    ? req.socket.remoteAddress
    : '');
  return remote || 'unknown';
}

function effectiveRequestProtocol(req) {
  if (req && req.headers) {
    const forwardedRaw = req.headers['x-forwarded-proto'];
    if (typeof forwardedRaw === 'string' && forwardedRaw.trim()) {
      const first = forwardedRaw.split(',')[0].trim().toLowerCase();
      if (first === 'http' || first === 'https') return `${first}:`;
    }
  }
  return (req && req.socket && req.socket.encrypted) ? 'https:' : 'http:';
}

function defaultPortForProtocol(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : null;
  const originRaw = headers && typeof headers.origin === 'string' ? headers.origin : '';
  const hostRaw = headers && typeof headers.host === 'string' ? headers.host : '';
  if (!originRaw || !hostRaw) return false;

  let origin;
  let expected;
  try {
    origin = new URL(originRaw);
    expected = new URL(`${effectiveRequestProtocol(req)}//${hostRaw}`);
  } catch {
    return false;
  }

  const originPort = origin.port || defaultPortForProtocol(origin.protocol);
  const expectedPort = expected.port || defaultPortForProtocol(expected.protocol);

  return (
    origin.protocol === expected.protocol &&
    origin.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
    originPort === expectedPort
  );
}

function createSignalingServer(options = {}) {
  const rawPort = Number(options.port ?? process.env.PORT ?? 8080);
  const port = Number.isFinite(rawPort) ? rawPort : 8080;
  const httpServer = options.server || null;
  const host = (typeof options.host === 'string' && options.host.trim())
    ? options.host.trim()
    : null;
  const maxPeersPerRoom = Number.isFinite(options.maxPeersPerRoom)
    ? Math.max(1, Math.floor(options.maxPeersPerRoom))
    : DEFAULT_MAX_PEERS_PER_ROOM;

  const maxPayloadBytes = Number.isFinite(options.maxPayloadBytes)
    ? Math.max(1024, Math.floor(options.maxPayloadBytes))
    : DEFAULT_MAX_PAYLOAD_BYTES;

  const waitingTtlMs = Number.isFinite(options.waitingTtlMs)
    ? Math.max(0, Math.floor(options.waitingTtlMs))
    : undefined;

  const pingIntervalMs = Number.isFinite(options.pingIntervalMs)
    ? Math.max(0, Math.floor(options.pingIntervalMs))
    : DEFAULT_PING_INTERVAL_MS;

  const maxConnections = parsePositiveInt(
    options.maxConnections ?? process.env.MAX_CONNECTIONS,
    DEFAULT_MAX_CONNECTIONS,
    1
  );

  const maxRooms = parsePositiveInt(
    options.maxRooms ?? process.env.MAX_ROOMS,
    DEFAULT_MAX_ROOMS,
    1
  );

  const maxMessagesPerWindow = parsePositiveInt(
    options.maxMessagesPerWindow ?? process.env.MAX_MESSAGES_PER_WINDOW,
    DEFAULT_MAX_MESSAGES_PER_WINDOW,
    1
  );

  const maxConnectionsPerIp = parsePositiveInt(
    options.maxConnectionsPerIp ?? process.env.MAX_CONNECTIONS_PER_IP,
    DEFAULT_MAX_CONNECTIONS_PER_IP,
    1
  );

  const maxMessagesPerIpPerWindow = parsePositiveInt(
    options.maxMessagesPerIpPerWindow ?? process.env.MAX_MESSAGES_PER_IP_PER_WINDOW,
    DEFAULT_MAX_MESSAGES_PER_IP_PER_WINDOW,
    1
  );

  const maxRoomOpsPerIpPerWindow = parsePositiveInt(
    options.maxRoomOpsPerIpPerWindow ?? process.env.MAX_ROOM_OPS_PER_IP_PER_WINDOW,
    DEFAULT_MAX_ROOM_OPS_PER_IP_PER_WINDOW,
    1
  );

  const messageRateWindowMs = parsePositiveInt(
    options.messageRateWindowMs ?? process.env.MESSAGE_RATE_WINDOW_MS,
    DEFAULT_MESSAGE_RATE_WINDOW_MS,
    100
  );

  const roomOpsWindowMs = parsePositiveInt(
    options.roomOpsWindowMs ?? process.env.ROOM_OPS_WINDOW_MS,
    DEFAULT_ROOM_OPS_WINDOW_MS,
    100
  );

  const roomOpsCooldownMs = parsePositiveInt(
    options.roomOpsCooldownMs ?? process.env.ROOM_OPS_COOLDOWN_MS,
    DEFAULT_ROOM_OPS_COOLDOWN_MS,
    100
  );

  const enforceSameOrigin = parseBooleanFlag(
    options.enforceSameOrigin ?? process.env.ENFORCE_SAME_ORIGIN,
    false
  );

  const trustProxy = parseBooleanFlag(
    options.trustProxy ?? process.env.TRUST_PROXY,
    false
  );

  const allowedOrigins = parseAllowedOrigins(
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? ''
  );

  const rooms = createRoomStore({ waitingTtlMs });
  const ipConnectionCounts = new Map();
  const ipMessageRates = new Map();
  const ipRoomOps = new Map();

  const wss = new WebSocketServer({
    ...(httpServer ? { server: httpServer } : { port, ...(host ? { host } : {}) }),
    maxPayload: maxPayloadBytes,
    perMessageDeflate: false,
  });

  const ready = httpServer
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });

  let pingTimer = null;
  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch {}
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, pingIntervalMs);
    try { pingTimer.unref(); } catch {}
  }

  function detachFromRoom(socket, state) {
    const roomId = state.currentRoomId;
    if (!roomId) return;

    const peers = rooms.getPeers(roomId, socket);
    for (const peer of peers) {
      safeSend(peer, { type: 'peer-left', roomId });
    }

    rooms.leaveRoom(roomId, socket);
    state.currentRoomId = null;
  }

  function incrementIpConnections(ip) {
    const next = (ipConnectionCounts.get(ip) || 0) + 1;
    ipConnectionCounts.set(ip, next);
    return next;
  }

  function decrementIpConnections(ip) {
    const next = (ipConnectionCounts.get(ip) || 0) - 1;
    if (next > 0) {
      ipConnectionCounts.set(ip, next);
      return;
    }
    ipConnectionCounts.delete(ip);
    ipMessageRates.delete(ip);
    ipRoomOps.delete(ip);
  }

  function exceededIpMessageRate(ip) {
    const now = Date.now();
    let state = ipMessageRates.get(ip);
    if (!state || ((now - state.windowStartedAt) >= messageRateWindowMs)) {
      state = {
        windowStartedAt: now,
        count: 0,
      };
    }

    state.count += 1;
    ipMessageRates.set(ip, state);
    return state.count > maxMessagesPerIpPerWindow;
  }

  function consumeRoomOpBudget(ip) {
    const now = Date.now();
    let state = ipRoomOps.get(ip);
    if (!state) {
      state = {
        windowStartedAt: now,
        count: 0,
        cooldownUntil: 0,
      };
    }

    if (state.cooldownUntil > now) {
      ipRoomOps.set(ip, state);
      return {
        ok: false,
        retryAfterMs: Math.max(1, state.cooldownUntil - now),
      };
    }

    if ((now - state.windowStartedAt) >= roomOpsWindowMs) {
      state.windowStartedAt = now;
      state.count = 0;
      state.cooldownUntil = 0;
    }

    state.count += 1;
    if (state.count > maxRoomOpsPerIpPerWindow) {
      state.count = 0;
      state.windowStartedAt = now;
      state.cooldownUntil = now + roomOpsCooldownMs;
      ipRoomOps.set(ip, state);
      return {
        ok: false,
        retryAfterMs: roomOpsCooldownMs,
      };
    }

    ipRoomOps.set(ip, state);
    return {
      ok: true,
      retryAfterMs: 0,
    };
  }

  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    // Backstop against socket-flood pressure.
    if (wss.clients.size > maxConnections) {
      try { socket.close(1013); } catch {}
      return;
    }

    const clientIp = getClientIp(req, trustProxy);
    if (incrementIpConnections(clientIp) > maxConnectionsPerIp) {
      decrementIpConnections(clientIp);
      try { socket.close(1013); } catch {}
      return;
    }

    if (allowedOrigins && !allowedOrigins.any) {
      const origin = (req && req.headers && typeof req.headers.origin === 'string') ? req.headers.origin : '';
      if (!origin || !allowedOrigins.set.has(origin)) {
        decrementIpConnections(clientIp);
        try { socket.close(1008); } catch {}
        return;
      }
    } else if (enforceSameOrigin && !isSameOriginRequest(req)) {
      decrementIpConnections(clientIp);
      try { socket.close(1008); } catch {}
      return;
    }

    const state = {
      currentRoomId: null,
      rateWindowStartedAt: Date.now(),
      rateCount: 0,
    };

    let cleanedUp = false;
    const cleanupSocket = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      detachFromRoom(socket, state);
      decrementIpConnections(clientIp);
    };

    socket.on('close', cleanupSocket);
    socket.on('error', cleanupSocket);

    function exceededMessageRate() {
      const now = Date.now();
      if ((now - state.rateWindowStartedAt) >= messageRateWindowMs) {
        state.rateWindowStartedAt = now;
        state.rateCount = 0;
      }

      state.rateCount += 1;
      return state.rateCount > maxMessagesPerWindow;
    }

    socket.on('message', (data) => {
      if (exceededIpMessageRate(clientIp)) {
        try { socket.close(1008); } catch {}
        return;
      }

      if (exceededMessageRate()) {
        try { socket.close(1008); } catch {}
        return;
      }

      // Extra belt-and-suspenders cap (ws maxPayload also applies).
      if (byteLengthUtf8(data) > maxPayloadBytes) {
        try { socket.close(1009); } catch {}
        return;
      }

      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        safeSend(socket, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (!message || typeof message !== 'object') {
        safeSend(socket, { type: 'error', message: 'Invalid message' });
        return;
      }

      const type = message.type;
      if (typeof type !== 'string') {
        safeSend(socket, { type: 'error', message: 'Invalid message type' });
        return;
      }

      switch (type) {
        case 'create-room': {
          const budget = consumeRoomOpBudget(clientIp);
          if (!budget.ok) {
            safeSend(socket, { type: 'error', message: 'Too many room operations; retry later', retryAfterMs: budget.retryAfterMs });
            return;
          }

          if (typeof message.roomId !== 'string') {
            safeSend(socket, { type: 'error', message: 'roomId required' });
            return;
          }
          const roomId = sanitizeRoomId(message.roomId);
          if (!roomId) {
            safeSend(socket, { type: 'error', message: 'Invalid roomId' });
            return;
          }

          if (state.currentRoomId) {
            safeSend(socket, { type: 'error', message: 'Already in a room' });
            return;
          }

          const existing = rooms.getRoom(roomId);
          if (existing) {
            safeSend(socket, { type: 'error', message: 'Room already exists' });
            return;
          }

          if (rooms.countRooms() >= maxRooms) {
            safeSend(socket, { type: 'error', message: 'Server busy' });
            return;
          }

          const room = rooms.createRoom(roomId);
          rooms.joinRoom(roomId, socket);
          state.currentRoomId = roomId;

          safeSend(socket, {
            type: 'room-created',
            roomId: room.id,
            peerCount: room.peers.size,
          });
          break;
        }

        case 'join-room': {
          const budget = consumeRoomOpBudget(clientIp);
          if (!budget.ok) {
            safeSend(socket, { type: 'error', message: 'Too many room operations; retry later', retryAfterMs: budget.retryAfterMs });
            return;
          }

          if (typeof message.roomId !== 'string') {
            safeSend(socket, { type: 'error', message: 'roomId required' });
            return;
          }
          const roomId = sanitizeRoomId(message.roomId);
          if (!roomId) {
            safeSend(socket, { type: 'error', message: 'Invalid roomId' });
            return;
          }

          if (state.currentRoomId) {
            safeSend(socket, { type: 'error', message: 'Already in a room' });
            return;
          }

          const room = rooms.getRoom(roomId);
          if (!room) {
            safeSend(socket, { type: 'error', message: 'Room not found' });
            return;
          }

          if (!room.peers.has(socket) && room.peers.size >= maxPeersPerRoom) {
            safeSend(socket, { type: 'error', message: 'Room full' });
            return;
          }

          rooms.joinRoom(roomId, socket);
          state.currentRoomId = roomId;

          safeSend(socket, {
            type: 'room-joined',
            roomId: room.id,
            peerCount: room.peers.size,
          });

          const peers = rooms.getPeers(roomId, socket);
          for (const peer of peers) {
            safeSend(peer, { type: 'peer-joined', roomId });
          }
          break;
        }

        case 'signal': {
          if (!state.currentRoomId) {
            safeSend(socket, { type: 'error', message: 'Not in a room' });
            return;
          }

          const room = rooms.getRoom(state.currentRoomId);
          if (!room) {
            // Room expired or was destroyed. Client must re-create/join.
            state.currentRoomId = null;
            safeSend(socket, { type: 'error', message: 'Room not found' });
            return;
          }

          const payload = message.payload;
          if (payload === undefined) {
            safeSend(socket, { type: 'error', message: 'payload required' });
            return;
          }

          const peers = rooms.getPeers(state.currentRoomId, socket);
          for (const peer of peers) {
            safeSend(peer, {
              type: 'signal',
              roomId: state.currentRoomId,
              payload, // opaque relay only
            });
          }
          break;
        }

        case 'leave-room': {
          if (!state.currentRoomId) return;

          detachFromRoom(socket, state);
          safeSend(socket, { type: 'room-left', roomId: null });
          break;
        }

        default:
          safeSend(socket, { type: 'error', message: 'Unknown message type' });
      }
    });
  });

  async function close() {
    try { if (pingTimer) clearInterval(pingTimer); } catch {}
    pingTimer = null;

    try { rooms.destroyAll(); } catch {}
    try { ipConnectionCounts.clear(); } catch {}
    try { ipMessageRates.clear(); } catch {}
    try { ipRoomOps.clear(); } catch {}

    // Deterministic shutdown: ensure the WebSocket server closes even if a client
    // never responds to a graceful close handshake.
    try {
      for (const ws of wss.clients) {
        try {
          if (typeof ws.terminate === 'function') ws.terminate();
          else ws.close();
        } catch {
          // intentionally silent
        }
      }
    } catch {}

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const t = setTimeout(finish, 1000);
      try { t.unref(); } catch {}

      try {
        wss.close(() => finish());
      } catch {
        finish();
      }
    });
  }

  return {
    wss,
    rooms,
    ready,
    close,
    get port() {
      try {
        const addr = wss.address();
        if (addr && typeof addr === 'object' && Number.isFinite(addr.port)) return addr.port;
      } catch {}

      if (httpServer && typeof httpServer.address === 'function') {
        try {
          const addr = httpServer.address();
          if (addr && typeof addr === 'object' && Number.isFinite(addr.port)) return addr.port;
        } catch {}
      }

      return port;
    },
  };
}

module.exports = {
  DEFAULT_MAX_PEERS_PER_ROOM,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_ROOMS,
  DEFAULT_MAX_MESSAGES_PER_WINDOW,
  DEFAULT_MESSAGE_RATE_WINDOW_MS,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_MAX_MESSAGES_PER_IP_PER_WINDOW,
  DEFAULT_MAX_ROOM_OPS_PER_IP_PER_WINDOW,
  DEFAULT_ROOM_OPS_WINDOW_MS,
  DEFAULT_ROOM_OPS_COOLDOWN_MS,
  createSignalingServer,
};
