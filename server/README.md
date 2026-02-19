# Ephera Signaling Server

## Purpose

This server exists ONLY for WebRTC signaling and peer coordination.
It relays connection metadata between peers so they can establish direct peer-to-peer connections.

---

## Zero-Memory Guarantees

### No Storage

- All rooms exist only in RAM
- No database, cache, or file system writes
- No Redis, no SQLite, no persistence layer

### No Logs

- Signaling payloads are NEVER logged
- Connection events are NOT recorded
- No audit trail exists

### No Recovery

- If the server crashes, ALL state is lost
- There is no backup or restore mechanism
- This is intentional, not a limitation

### Stateless By Design

- Rooms die when empty
- Waiting rooms (0-1 peer) expire after 10 minutes
- Peers are tracked only by socket reference
- No identity, no accounts, no sessions
- Max 2 peers per room (P2P pairing)

---

## What This Server Does

| Action | Description |
|--------|-------------|
| `create-room` | Creates an ephemeral room in memory |
| `join-room` | Adds a peer to an existing room |
| `signal` | Relays opaque signaling data to peers |
| `leave-room` | Removes peer and destroys room if empty |

---

## Hardening Defaults

- Max 2 peers per room
- WebSocket `maxPayload` cap (default 256KB)
- Optional Origin allowlist via `ALLOWED_ORIGINS` (comma-separated) or `*` to allow all
- Ping/pong keepalive to clean up half-open sockets (no telemetry)

---

## What This Server Does NOT Do

- ❌ Store files or file metadata
- ❌ Relay file bytes
- ❌ Log signaling content
- ❌ Persist rooms across restarts
- ❌ Authenticate users
- ❌ Track analytics or metrics
- ❌ Recover from crashes

---

## Compliance

This server is fully compliant with `ZERO_MEMORY_MANIFESTO.md`.

All data is ephemeral. All state dies with the process.

---

## Usage

```bash
# Install minimal dependency
npm install ws

# Run server
node index.js

# Server listens on PORT (default 8080)
```

## Tests

```bash
npm test
```

Current server test coverage includes:
- signaling protocol behavior (`create-room`, `join-room`, relay, room limits)
- waiting-room TTL behavior
- app server static/security headers (`Cache-Control`, `CSP`, `nosniff`, `no-referrer`)
- same-origin WebSocket signaling on `server/serve.js`

---

## Architecture

```
Client A                Signaling Server              Client B
   |                          |                          |
   |------ create-room ------>|                          |
   |<----- room-created ------|                          |
   |                          |                          |
   |                          |<------ join-room --------|
   |<----- peer-joined -------|------- room-joined ----->|
   |                          |                          |
   |------ signal (SDP) ----->|------- signal (SDP) ---->|
   |<----- signal (SDP) ------|<------ signal (SDP) -----|
   |                          |                          |
   |========== WebRTC P2P Connection Established ========|
   |                          |                          |
   |  (File transfer happens directly, server excluded)  |
```

---

## Destruction Guarantees

- Room destroyed when last peer disconnects
- Waiting room destroyed after 10 minute TTL (0-1 peer)
- All rooms destroyed on `SIGINT` / `SIGTERM`
- All rooms destroyed on process crash (automatic)
