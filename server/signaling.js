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

  const allowedOrigins = parseAllowedOrigins(
    options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? ''
  );

  const rooms = createRoomStore({ waitingTtlMs });

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

  wss.on('connection', (socket, req) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    if (allowedOrigins && !allowedOrigins.any) {
      const origin = (req && req.headers && typeof req.headers.origin === 'string') ? req.headers.origin : '';
      if (!origin || !allowedOrigins.set.has(origin)) {
        try { socket.close(1008); } catch {}
        return;
      }
    }

    const state = { currentRoomId: null };

    socket.on('message', (data) => {
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

    socket.on('close', () => {
      detachFromRoom(socket, state);
    });

    socket.on('error', () => {
      detachFromRoom(socket, state);
    });
  });

  async function close() {
    try { if (pingTimer) clearInterval(pingTimer); } catch {}
    pingTimer = null;

    try { rooms.destroyAll(); } catch {}

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
  createSignalingServer,
};
