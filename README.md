# Ephera

Ephera is a **zero-memory, trustless, peer-to-peer transport engine**.

## Live Website

[Launch Ephera](https://ephera.onrender.com)

- No server-side file storage
- No logs of payload content
- No transfer history
- WebRTC DataChannel for direct P2P bytes
- A stateless WebSocket server exists only for signaling

See `ZERO_MEMORY_MANIFESTO.md` for the non-negotiable constraints.

## Repo Layout

- `client/`: Browser engine + minimal UI (ES modules)
- `server/`: Stateless signaling server (Node + `ws`)
- `docs/`: Invariants, gates, and freeze notes
- `client/test/`: Canonical regression tests (Stage 3/4)

For a file-by-file map, see `docs/PROJECT_MAP.md`.

## Run (Local Dev)

1. `npm install` (installs root deps + signaling server deps)
2. `npm run dev`
3. Open `http://localhost:3000` in two browser tabs or two machines on the same LAN.
4. Create a room on one side, join from the other.
   - The creator gets an ephemeral **Room Auth Key** (shown in UI and embedded in join link).
5. On the receiving side, click **Pick Receive Folder** (saves) or **Ready (Discard)** (receive without saving). This is the peer “ready” signal.
6. Send one or more files from the other side (each file is a concurrent transfer).

Notes:
- Signaling is same-origin by default (example: `ws://localhost:3000`).
- To override signaling in the client, open `http://localhost:3000?signalPort=8080` (or `?signalUrl=ws://host:port`).
- ICE servers can be overridden in the client URL:
  - `?stun=stun:stun.l.google.com:19302`
  - `?turn=turn:turn.example.com:3478&turnUser=USER&turnPass=PASS`
- Or paste `iceServers` JSON in the UI under **Advanced network (ICE/TURN)** (in-memory only).
- The receiver saves to a user-chosen folder (user action, outside the trust boundary). If no folder is chosen, incoming bytes are discarded to preserve zero-memory behavior.
- File metadata (name/type/size) is sent over the P2P channel to allow the receiver to save using the original filename and show progress.
- Recommended: use the **Secure Mode passphrase** on both peers to enable app-layer encryption (AES-256-GCM per chunk). The initiator auto-generates a passphrase on **Create**; share it out-of-band (do not rely on URLs).
- The in-app **Join link** always places `roomJoinKey` in the URL fragment (`#...`), not query params, so it is not sent in HTTP request lines/server access logs.
- If you explicitly enable **Include passphrase in join link**, passphrase is also placed in the URL fragment (`#...`) only.
- ICE/TURN config is excluded from join links unless you explicitly enable **Include ICE/TURN config in join link**.
- Room owner controls: the room owner can rotate the room auth key and close the room from the **Connection** panel; non-owner peers are fail-closed.
- Join links include `autojoin=1` so receivers open and join immediately; receiving still requires explicit **Pick Receive Folder** or **Ready (Discard)**.
- Launchpad supports **Invite Package** intake: paste a full package, JSON payload, or raw join link, then click **Apply** or **Apply + Join**.
- Launchpad also supports **QR Pairing**: render invite QR locally, scan from QR image, or use camera scan. Scan uses `BarcodeDetector` when available, with local `jsQR` fallback for browsers without detector support.
- If a share link contains `passphrase`, `roomJoinKey`/`joinKey`, or ICE/TURN config, Ephera strips it from the address bar after reading it (reduces persistence risk).
- Legacy secret links that used query params are still accepted for compatibility, then stripped immediately.

## Run (Single Port / Deploy)

This serves the static client and the signaling WebSocket on the **same origin** (recommended):

```bash
npm start
```

Environment variables:
- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)
- `TLS_KEY_PATH` + `TLS_CERT_PATH` (optional: serve HTTPS + WSS directly)
- `ICE_SERVERS_JSON` (optional JSON array of `RTCIceServer` defaults served to clients at `/runtime-config`)
- `ICE_TRANSPORT_POLICY` (optional: `relay` or `all`; default `all`)
- `TURN_URLS_JSON` (optional JSON array of `turn:` / `turns:` URLs for dynamic TURN auth)
- `TURN_AUTH_SECRET` (optional shared TURN REST secret; must be set with `TURN_URLS_JSON`, min length `16`, must not be `change-me-secret`)
- `TURN_TTL_SECONDS` (optional dynamic TURN credential TTL, range `30..86400`, default `600`)
- `ALLOWED_ORIGINS` (optional signaling Origin allowlist; comma-separated or `*`)
- `MAX_CONNECTIONS` (optional signaling connection cap; default `2048`)
- `MAX_CONNECTIONS_PER_IP` (optional signaling per-IP connection cap; default `64`)
- `MAX_ROOMS` (optional in-memory room cap; default `4096`)
- `MAX_MESSAGES_PER_WINDOW` (optional per-socket rate cap; default `240`)
- `MAX_MESSAGES_PER_IP_PER_WINDOW` (optional per-IP rate cap within `MESSAGE_RATE_WINDOW_MS`; default `1200`)
- `MESSAGE_RATE_WINDOW_MS` (optional rate window size; default `10000`)
- `MAX_ROOM_OPS_PER_IP_PER_WINDOW` (optional per-IP `create-room`/`join-room` attempt budget; default `120`)
- `ROOM_OPS_WINDOW_MS` (optional room-op budget window; default `60000`)
- `ROOM_OPS_COOLDOWN_MS` (optional per-IP cooldown after room-op budget is exceeded; default `30000`)
- `MAX_OWNER_OPS_PER_IP_PER_WINDOW` (optional per-IP owner-op budget for `rotate-room-join-key` / `close-room`; default `60`)
- `OWNER_OPS_WINDOW_MS` (optional owner-op budget window; default `60000`)
- `OWNER_OPS_COOLDOWN_MS` (optional per-IP cooldown after owner-op budget is exceeded; default `30000`)
- `JOIN_DENY_DELAY_MS` (optional delay for `join-room` denial shaping; default `120`; miss/full return `Join unavailable`)
- `TRUST_PROXY` (optional, default `0`; set `1` only behind trusted proxy to use `X-Forwarded-For` for per-IP controls)
- `ENFORCE_SAME_ORIGIN` (app-server WS origin policy: default `1`; set `0` only behind trusted edge controls)
- `SHUTDOWN_GRACE_MS` (optional app-server forced-drain timeout for stuck HTTP sockets on shutdown, range `0..600000`, default `3000`)

If you don’t provide TLS in Ephera itself, deploy behind a TLS-terminating reverse proxy so browsers see `https://...` (required for folder-based saving).

Health/runtime endpoints:
- `GET /healthz` (liveness)
- `GET /readyz` (readiness)
- `GET /runtime-config` (server-provided ICE/TURN defaults; dynamic TURN creds are minted per request, no persistence)

App-server security default:
- `npm start` enforces same-origin WebSocket `Origin` checks by default.
- To relax for controlled environments, set `ENFORCE_SAME_ORIGIN=0` and use explicit network controls/allowlists.

See `docs/DEPLOYMENT.md` for reverse proxy examples (and how to disable access logs).

Quick public staging option (no custom domain required):

- Use Render blueprint in `render.yaml` to deploy to `https://<service>.onrender.com`
- Then run GitHub Actions `staging-smoke` against that URL

Docker (HTTP, recommended behind TLS reverse proxy):

```bash
docker build -t ephera .
docker run --rm -p 3000:3000 ephera
```

Docker Compose profile with bundled `coturn` (relay-only defaults via `/runtime-config`):

```bash
cp deploy/turn.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.turn.yml up --build
```

### Secure Context (For Saving On Other Devices)

Browsers require a **secure context** for folder-based streaming saves (`showDirectoryPicker`). `http://<LAN-IP>` is not a secure context, so receiving peers on other devices may be forced into discard mode.

Run the HTTPS + WSS dev runner:

```bash
npm run dev:secure
```

This will auto-generate a self-signed cert (via `openssl`) into `.ephera-dev-tls/` if you don’t provide one.

Then open `https://<host>:3000` on both devices and accept the certificate warning (self-signed).

To use your own cert:

```bash
TLS_KEY_PATH=/path/to/key.pem TLS_CERT_PATH=/path/to/cert.pem npm run dev:secure
```

## Tests

Run the full test suite (client engine + signaling server):

```bash
npm test
```

Run server-only tests:

```bash
npm run test:server
```

Run real WebRTC E2E (headless Chrome):

```bash
npm run e2e
```

Run fast E2E smoke suite (for quick CI/local feedback):

```bash
npm run e2e:fast
```

Run deploy-targeted staging smoke (expects a running environment URL):

```bash
STAGING_BASE_URL='https://staging.example.com' npm run e2e:staging-smoke
```

### CI (GitHub Actions)

- `fast-checks` runs on all pushes/PRs: `npm test` + `npm run e2e:fast`.
- `full-e2e` runs on `main`, scheduled runs, or manual dispatch.
- `relay-required` runs on `main`, scheduled runs, or manual dispatch.
- `staging-smoke` is manual (`workflow_dispatch`) and validates create/join, transport open, small transfer, and receiver-cancel abort on a deployed URL.
- `nightly-signaling-stress` runs on schedule/manual with heavy server stress + fuzz profiles.
  - uses reproducible fuzz seed: `SIGNALING_FUZZ_SEED=<github.run_id>`
  - uploads JSON artifacts:
    - `signaling-stress-summary-<run_id>`
    - `signaling-fuzz-summary-<run_id>`
- `required-checks` always runs and enforces:
  - all events: `fast-checks` must pass
  - `main`/schedule/manual: `full-e2e` and `relay-required` must also pass
  - schedule/manual: `nightly-signaling-stress` must also pass
  - other branches/PRs: full jobs may be skipped without failing required checks

Run heavy server stress profile locally:

```bash
npm run test:server:stress-heavy
```

Run standalone signaling fuzz suite:

```bash
npm run test:server:fuzz
```

Run heavy signaling fuzz profile:

```bash
npm run test:server:fuzz-heavy
```

Run relay runtime E2E with dynamic TURN auth (recommended):

```bash
E2E_TURN_URL='turn:YOUR_TURN_HOST:3478?transport=udp' \
E2E_TURN_URL_TCP='turn:YOUR_TURN_HOST:3478?transport=tcp' \
E2E_TURN_AUTH_SECRET='YOUR_TURN_SHARED_SECRET' \
E2E_TURN_TTL_SECONDS=600 \
npm run e2e:relay
```

Static TURN auth fallback:

```bash
E2E_TURN_URL='turn:YOUR_TURN_HOST:3478?transport=udp' \
E2E_TURN_URL_TCP='turn:YOUR_TURN_HOST:3478?transport=tcp' \
E2E_TURN_USERNAME='TURN_USER' \
E2E_TURN_CREDENTIAL='TURN_PASS' \
npm run e2e:relay
```

Run relay runtime as a required gate (fails if relay scenario is not executed):

```bash
E2E_TURN_URL='turn:YOUR_TURN_HOST:3478?transport=udp' \
E2E_TURN_URL_TCP='turn:YOUR_TURN_HOST:3478?transport=tcp' \
E2E_TURN_AUTH_SECRET='YOUR_TURN_SHARED_SECRET' \
npm run e2e:relay:required
```

Run one-command local relay gate with bundled coturn profile:

```bash
cp deploy/turn.env.example deploy/.env
# edit deploy/.env and set TURN_AUTH_SECRET to a real secret (not "change-me-secret")
npm run gates:relay-local
```

Run full gates including required relay runtime:

```bash
npm run gates:full
```

This includes gates for:
- passphrase mismatch (send stays disabled)
- protocol mismatch (send stays disabled)
- signaling restart/crash resilience
- secure runtime path (`dev-secure.js`: HTTPS + WSS, self-signed cert handling)
- join-link auto-join flow
- folder-save path verification (in-memory File System Access polyfill, validates saved bytes + `saved` receipt)

Run heavier perf E2E gates (includes 100MB transfer + heap/buffer sampling):

```bash
npm run e2e:perf
```

Run optional soak gates (idle connection + extra connect/disconnect cycles):

```bash
npm run e2e:soak
```

Run everything (unit/regression + E2E):

```bash
npm run verify
```

Run everything including perf E2E:

```bash
npm run perf
```

Manual memory verification in Chrome DevTools is still recommended before release (see `PERFORMANCE_HARDENING_CHECKLIST.md`).
