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

  function createRoom(roomId, options = {}) {
    if (rooms.has(roomId)) {
      return rooms.get(roomId);
    }

    const joinKey = (options && typeof options.joinKey === 'string') ? options.joinKey : '';
    const ownerPeerId = (options && typeof options.ownerPeerId === 'string' && options.ownerPeerId)
      ? options.ownerPeerId
      : null;
    const room = {
      id: roomId,
      joinKey,
      ownerPeerId,
      peers: new Set(),
      peerIds: new Map(),
      waitingTimer: null,
    };

    rooms.set(roomId, room);
    armWaitingTtl(room);
    return room;
  }

  function joinRoom(roomId, socket, peerId = null) {
    const room = rooms.get(roomId);
    if (!room) return null;

    room.peers.add(socket);
    if (typeof peerId === 'string' && peerId) {
      room.peerIds.set(socket, peerId);
    }

    if (room.peers.size >= 2) {
      disarmWaitingTtl(room);
    } else {
      armWaitingTtl(room);
    }

    return room;
  }

  function leaveRoom(roomId, socket) {
    const room = rooms.get(roomId);
    if (!room) {
      return {
        destroyed: false,
        ownerChanged: false,
        roomOwnerPeerId: null,
        leftPeerId: null,
      };
    }

    const leftPeerId = room.peerIds.get(socket) || null;
    room.peers.delete(socket);
    room.peerIds.delete(socket);

    let ownerChanged = false;
    if (leftPeerId && room.ownerPeerId === leftPeerId && room.peers.size > 0) {
      const nextOwnerSocket = room.peers.values().next().value || null;
      const nextOwnerPeerId = nextOwnerSocket ? (room.peerIds.get(nextOwnerSocket) || null) : null;
      room.ownerPeerId = nextOwnerPeerId;
      ownerChanged = !!nextOwnerPeerId;
    }

    if (room.peers.size === 0) {
      destroyRoom(roomId);
      return {
        destroyed: true,
        ownerChanged: false,
        roomOwnerPeerId: null,
        leftPeerId,
      };
    }

    // If a room becomes a waiting room again, re-arm the waiting TTL.
    if (room.peers.size < 2) armWaitingTtl(room);

    return {
      destroyed: false,
      ownerChanged,
      roomOwnerPeerId: room.ownerPeerId,
      leftPeerId,
    };
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
    room.peerIds.clear();
    room.ownerPeerId = null;
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

  function countRooms() {
    return rooms.size;
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    destroyRoom,
    getRoom,
    getPeers,
    countRooms,
    destroyAll,
  };
}

module.exports = {
  DEFAULT_WAITING_TTL_MS,
  createRoomStore,
};
