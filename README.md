# Ephera

Ephera is a **zero-memory, trustless, peer-to-peer transport engine**.

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
- The in-app **Join link** intentionally does not include passphrase or ICE/TURN config unless you explicitly enable the checkboxes (to reduce accidental leakage via access logs).
- Join links include `autojoin=1` so receivers open and join immediately; receiving still requires explicit **Pick Receive Folder** or **Ready (Discard)**.
- If a share link contains `passphrase` or ICE/TURN config, Ephera strips it from the address bar after reading it (reduces persistence risk).

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

If you don’t provide TLS in Ephera itself, deploy behind a TLS-terminating reverse proxy so browsers see `https://...` (required for folder-based saving).

Health/runtime endpoints:
- `GET /healthz` (liveness)
- `GET /readyz` (readiness)
- `GET /runtime-config` (server-provided ICE/TURN defaults, no persistence)

See `docs/DEPLOYMENT.md` for reverse proxy examples (and how to disable access logs).

Docker (HTTP, recommended behind TLS reverse proxy):

```bash
docker build -t ephera .
docker run --rm -p 3000:3000 ephera
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

Run real WebRTC E2E (headless Chrome):

```bash
npm run e2e
```

This includes gates for:
- passphrase mismatch (send stays disabled)
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
