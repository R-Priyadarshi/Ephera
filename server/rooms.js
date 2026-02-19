/**
 * EPHERA — In-Memory Room Lifecycle (Room Store)
 *
 * ZERO-MEMORY GUARANTEES:
 * - All state exists only in RAM
 * - No persistence
 * - No diagnostics
 * - No metrics
 * - Process death = total amnesia
 */

const DEFAULT_WAITING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function createRoomStore({ waitingTtlMs = DEFAULT_WAITING_TTL_MS } = {}) {
  const WAITING_TTL_MS = Number.isFinite(waitingTtlMs) ? Math.max(0, waitingTtlMs) : DEFAULT_WAITING_TTL_MS;

  const rooms = new Map();

  function armWaitingTtl(room) {
    if (!room) return;
    if (WAITING_TTL_MS <= 0) return;

    // Only used to expire rooms that are "waiting" (0-1 peers). Active rooms
    // with 2 peers must not be killed by an absolute timer.
    if (room.peers.size >= 2) return;

    if (room.waitingTimer) return;

    room.waitingTimer = setTimeout(() => {
      // If the room is still waiting, destroy it. If it became active, ignore.
      const live = rooms.get(room.id);
      if (!live) return;
      if (live.peers.size >= 2) return;
      destroyRoom(room.id);
    }, WAITING_TTL_MS);

    // Do not keep the process alive just because a room is waiting.
    try { room.waitingTimer.unref(); } catch {}
  }

  function disarmWaitingTtl(room) {
    if (!room || !room.waitingTimer) return;
    try { clearTimeout(room.waitingTimer); } catch {}
    room.waitingTimer = null;
  }

  function createRoom(roomId) {
    if (rooms.has(roomId)) {
      return rooms.get(roomId);
    }

    const room = {
      id: roomId,
      peers: new Set(),
      waitingTimer: null,
    };

    rooms.set(roomId, room);
    armWaitingTtl(room);
    return room;
  }

  function joinRoom(roomId, socket) {
    const room = rooms.get(roomId);
    if (!room) return null;

    room.peers.add(socket);

    if (room.peers.size >= 2) {
      disarmWaitingTtl(room);
    } else {
      armWaitingTtl(room);
    }

    return room;
  }

  function leaveRoom(roomId, socket) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.peers.delete(socket);

    if (room.peers.size === 0) {
      destroyRoom(roomId);
      return;
    }

    // If a room becomes a waiting room again, re-arm the waiting TTL.
    if (room.peers.size < 2) armWaitingTtl(room);
  }

  function destroyRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    disarmWaitingTtl(room);

    for (const peer of room.peers) {
      try {
        peer.close();
      } catch {
        // intentionally silent
      }
    }

    room.peers.clear();
    rooms.delete(roomId);
  }

  function getRoom(roomId) {
    return rooms.get(roomId);
  }

  function getPeers(roomId, excludeSocket) {
    const room = rooms.get(roomId);
    if (!room) return [];

    const peers = [];
    for (const peer of room.peers) {
      if (peer !== excludeSocket && peer.readyState === 1) {
        peers.push(peer);
      }
    }
    return peers;
  }

  function destroyAll() {
    for (const roomId of rooms.keys()) {
      destroyRoom(roomId);
    }
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    destroyRoom,
    getRoom,
    getPeers,
    destroyAll,
  };
}

module.exports = {
  DEFAULT_WAITING_TTL_MS,
  createRoomStore,
};

