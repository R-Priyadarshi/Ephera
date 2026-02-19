# Deployment Notes

Ephera is designed to be deployed as a **single origin**:

- Static client: `GET /`
- Signaling WebSocket: `WS /` (upgrade)

No payload bytes ever transit the server (signaling only).

## Recommended Deployment

1. Terminate TLS at a reverse proxy (so browsers see `https://...` and `wss://...`).
2. Forward all requests (including WebSocket upgrades) to the Ephera app server (`npm start`).
3. Disable access logs at the reverse proxy if you want the strongest "no metadata retention" posture.

Why TLS matters:
- Folder-based streaming receive (`showDirectoryPicker`) requires a **secure context**.
- A secure context usually means `https://...` (or `http://localhost` only).

## Ephera App Server

Run the combined static + signaling server:

```bash
PORT=3000 HOST=0.0.0.0 npm start
```

Serve HTTPS directly (optional):

```bash
TLS_KEY_PATH=/path/key.pem TLS_CERT_PATH=/path/cert.pem PORT=3000 npm start
```

NOTE:
- If you run Ephera behind a TLS reverse proxy, you normally do **not** set `TLS_*` here.
- Ephera is intentionally silent by default. Set `VERBOSE=1` if you want startup output.
- Health endpoints are available for orchestration:
  - `GET /healthz` (liveness)
  - `GET /readyz` (readiness)

## Runtime TURN/ICE Defaults (Server-Driven)

For production NAT traversal, set TURN/STUN defaults on the app server:

```bash
ICE_SERVERS_JSON='[{"urls":"stun:stun.example.net:3478"},{"urls":"turn:turn.example.net:3478","username":"USER","credential":"PASS"}]' \
ICE_TRANSPORT_POLICY=relay \
npm start
```

Behavior:
- App server exposes `GET /runtime-config` with sanitized ICE defaults.
- Browser client loads these defaults automatically.
- URL-provided ICE config (`iceServers`, `stun`, `turn`, `icePolicy`) still takes precedence.

### Recommended: Dynamic TURN Credentials (No Static TURN Password In Clients)

When using coturn REST auth (`use-auth-secret`), configure Ephera to mint short-lived TURN credentials per request:

```bash
TURN_URLS_JSON='["turn:turn.example.net:3478?transport=udp","turns:turn.example.net:5349?transport=tcp"]' \
TURN_AUTH_SECRET='YOUR_TURN_SHARED_SECRET' \
TURN_TTL_SECONDS=600 \
ICE_TRANSPORT_POLICY=relay \
npm start
```

Behavior:
- Each `GET /runtime-config` call mints a fresh TURN `username` + `credential` pair in RAM.
- Credentials are HMAC-SHA1 signed and expire after `TURN_TTL_SECONDS`.
- No TURN credential history is persisted by Ephera.

Validation rules:
- `TURN_URLS_JSON` and `TURN_AUTH_SECRET` must be set together.
- `TURN_TTL_SECONDS` must be between `30` and `86400`.
- `TURN_URLS_JSON` entries must be `turn:` or `turns:` URLs.

## Signaling Abuse Controls

The signaling server supports built-in guardrails (all RAM-only, no telemetry):

- `ALLOWED_ORIGINS` (comma-separated, or `*`)
- `MAX_CONNECTIONS` (default `2048`)
- `MAX_ROOMS` (default `4096`)
- `MAX_MESSAGES_PER_WINDOW` (default `240`)
- `MESSAGE_RATE_WINDOW_MS` (default `10000`)

Example:

```bash
ALLOWED_ORIGINS='https://app.example.com' \
MAX_CONNECTIONS=5000 \
MAX_ROOMS=10000 \
MAX_MESSAGES_PER_WINDOW=300 \
MESSAGE_RATE_WINDOW_MS=10000 \
npm start
```

## TURN Compose Profile (Reference)

This repo includes a local production-like profile with Ephera + coturn:

```bash
cp deploy/turn.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.turn.yml up --build
```

Notes:
- Set `PUBLIC_TURN_HOST` to an address reachable by browsers (not container-internal DNS).
- Open TURN relay UDP range (`TURN_MIN_PORT` to `TURN_MAX_PORT`) in your firewall/security group.
- No persistent TURN log volume is configured (stdout only).

## Reverse Proxy Examples

### Nginx (TLS termination + no access log)

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

  access_log off;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

### Caddy (TLS termination + discard logs)

```caddyfile
example.com {
  reverse_proxy 127.0.0.1:3000

  log {
    output discard
  }
}
```

## Operational Notes

- Ephera signaling rooms are RAM-only. Restarting the server destroys all rooms.
- Keep the signaling + static server same-origin if possible (simplest and safest).
- For NAT traversal at scale, prefer server-driven defaults (`ICE_SERVERS_JSON` + `ICE_TRANSPORT_POLICY`) over URL params.
