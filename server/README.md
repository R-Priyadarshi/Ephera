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
| `create-room` | Creates an ephemeral room in memory, mints `peerId`, returns `roomJoinKey` and owner role |
| `join-room` | Adds a peer only when `roomJoinKey` matches; returns ephemeral `peerId` + owner state |
| `signal` | Relays opaque signaling data to peers |
| `leave-room` | Removes peer and destroys room if empty |
| `rotate-room-join-key` | Owner-only: rotates room admission key in RAM and notifies current peers |
| `close-room` | Owner-only: closes room membership (without persistence) and notifies current peers |

---

## Hardening Defaults

- Max 2 peers per room
- WebSocket `maxPayload` cap (default 256KB)
- Optional Origin allowlist via `ALLOWED_ORIGINS` (comma-separated) or `*` to allow all
- Ping/pong keepalive to clean up half-open sockets (no telemetry)
- Connection cap (`MAX_CONNECTIONS`, default 2048)
- Per-IP connection cap (`MAX_CONNECTIONS_PER_IP`, default 64)
- Room cap (`MAX_ROOMS`, default 4096)
- Per-socket message-rate limiter:
  - `MAX_MESSAGES_PER_WINDOW` (default 240)
  - `MESSAGE_RATE_WINDOW_MS` (default 10000)
- Per-IP message-rate limiter:
  - `MAX_MESSAGES_PER_IP_PER_WINDOW` (default 1200)
  - Uses the same `MESSAGE_RATE_WINDOW_MS`
- Per-IP room operation throttle (`create-room`/`join-room`):
  - `MAX_ROOM_OPS_PER_IP_PER_WINDOW` (default 120)
  - `ROOM_OPS_WINDOW_MS` (default 60000)
  - `ROOM_OPS_COOLDOWN_MS` (default 30000)
- Per-IP owner operation throttle (`rotate-room-join-key`/`close-room`):
  - `MAX_OWNER_OPS_PER_IP_PER_WINDOW` (default 60)
  - `OWNER_OPS_WINDOW_MS` (default 60000)
  - `OWNER_OPS_COOLDOWN_MS` (default 30000)
- Join denial shaping (`join-room` miss/full):
  - `JOIN_DENY_DELAY_MS` (default 120)
  - Both missing-room and full-room joins return `Join unavailable`
- Ephemeral room admission auth:
  - `create-room` returns in-memory `roomJoinKey`
  - `join-room` requires matching `roomJoinKey` (missing/wrong key -> `Join unavailable`)
- Ephemeral peer identity + owner authority:
  - Each socket gets ephemeral `peerId` (RAM-only)
  - Room owner (`ownerPeerId`) is tracked in RAM and returned in create/join responses
  - Owner-only controls:
    - `rotate-room-join-key` (non-owner -> `Owner privileges required`)
    - `close-room` (non-owner -> `Owner privileges required`)
  - Owner departure transfers ownership to a remaining peer deterministically (if any)
- Client join-link secret hygiene:
  - Join links carry `roomJoinKey` (and optional passphrase) in URL fragment (`#...`), not query params
  - URL fragments are not sent to HTTP/WebSocket servers, reducing accidental secret exposure in access logs
- `TRUST_PROXY=1` (optional) enables `X-Forwarded-For` for per-IP controls
  - Default is off (`TRUST_PROXY=0`) to prevent header spoofing
- App-server mode (`serve.js`) enforces same-origin WebSocket `Origin` checks by default
  - `ENFORCE_SAME_ORIGIN=1` (default), set `0` only in controlled environments
- Deterministic app-server shutdown drain:
  - `SHUTDOWN_GRACE_MS` (default `3000`, range `0..600000`)
  - After this grace window, stuck HTTP sockets are force-closed so process exit cannot hang

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

App server mode (static client + same-origin signaling):

```bash
PORT=3000 HOST=0.0.0.0 node serve.js
```

Optional runtime ICE/TURN defaults for browser clients:

```bash
ICE_SERVERS_JSON='[{"urls":"stun:stun.example.net:3478"},{"urls":"turn:turn.example.net:3478","username":"USER","credential":"PASS"}]' \
ICE_TRANSPORT_POLICY=relay \
node serve.js
```

Recommended production TURN mode (coturn REST auth, short-lived credentials):

```bash
TURN_URLS_JSON='["turn:turn.example.net:3478?transport=udp","turns:turn.example.net:5349?transport=tcp"]' \
TURN_AUTH_SECRET='YOUR_TURN_SHARED_SECRET' \
TURN_TTL_SECONDS=600 \
ICE_TRANSPORT_POLICY=relay \
node serve.js
```

Notes:
- `TURN_URLS_JSON` + `TURN_AUTH_SECRET` must be set together.
- `TURN_AUTH_SECRET` must be at least 16 characters and must not be `change-me-secret`.
- `TURN_TTL_SECONDS` range is `30..86400` (default `600`).
- `/runtime-config` mints fresh TURN credentials per request (RAM-only).

App server operational endpoints:
- `GET /healthz`
- `GET /readyz`
- `GET /runtime-config`

Compose TURN profile (repo root):

```bash
cp deploy/turn.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.turn.yml up --build
```

The compose profile uses coturn REST auth (`TURN_AUTH_SECRET`) and Ephera dynamic runtime TURN credentials.

## Tests

```bash
npm test
```

Current server test coverage includes:
- signaling protocol behavior (`create-room`, `join-room`, relay, room limits)
- signaling pressure controls (global + per-IP caps, trust-proxy behavior)
- signaling room-abuse throttle (per-IP create/join budget + cooldown)
- signaling join-enumeration resistance (unified miss/full denial + delay shaping)
- signaling room admission auth (`roomJoinKey` required for join success)
- signaling Stage 17 owner-authority behavior (`peerId` contract, owner-only controls, owner transfer)
- signaling Stage 19 owner-op abuse throttling (`rotate-room-join-key`/`close-room` per-IP cooldown enforcement)
- waiting-room TTL behavior
- app server static/security headers (`Cache-Control`, `CSP`, `nosniff`, `no-referrer`)
- app server health/readiness/runtime-config endpoints
- app server deterministic shutdown under hung HTTP connections
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
