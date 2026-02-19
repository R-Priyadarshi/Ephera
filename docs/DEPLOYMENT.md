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
- If you need TURN for NAT traversal, configure ICE servers on both peers (client URL params currently).

