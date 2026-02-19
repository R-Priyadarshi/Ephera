# EPHERA — Threat Model & Security Analysis

**Document Type:** Security Analysis  
**Scope:** Architecture-level reasoning  
**Date:** 2024-12-24

---

## 1. Threat Actors

### 1.1 Malicious Sender

**What they can observe:**
- Their own file content
- Room ID they created
- Connection state to receiver
- ICE candidates and SDP of receiver

**What they cannot observe:**
- Receiver's local file system
- Receiver's browser state beyond connection
- Whether receiver saved data locally (outside Ephera)

**Data at risk:**
- None from Ephera's perspective — sender controls their own data

**Blast radius limitation:**
- Sender can only send data; cannot force receiver to persist
- Receiver's stream consumption does not expose receiver state
- Connection terminates when receiver disconnects

---

### 1.2 Malicious Receiver

**What they can observe:**
- Incoming stream content
- Meaning signals (mime hint, category, size range)
- Sender's ICE candidates and SDP

**What they cannot observe:**
- Sender's file system
- Sender's other transfers
- Room IDs they did not join

**Data at risk:**
- Sender's transmitted content (receiver sees everything sent)

**Blast radius limitation:**
- Ephera does not prevent receiver from saving received data locally
- Ephera guarantees no *server-side* or *Ephera-side* persistence
- Receiver's local actions are outside Ephera's threat model

---

### 1.3 Compromised Signaling Server

**What they can observe:**
- Room IDs
- Peer connection/disconnection events
- SDP offers/answers (contains ICE candidates, codec info)
- Meaning signals (if routed through signaling)
- Timing metadata (when rooms created, joined, destroyed)

**What they cannot observe:**
- File bytes *if the server remains a pure signaling relay* (default Ephera design)
- Decrypted payload in **passphrase mode** (AES-GCM per chunk), unless the passphrase is leaked

**Data at risk:**
- Connection metadata only
- Room existence patterns
- Timing correlation attacks possible
- If the signaling server is malicious and performs an active MITM (by terminating WebRTC as an endpoint), **plain mode** payload content is at risk

**Blast radius limitation:**
- Server holds no file data — compromise yields zero payload recovery
- Server state is RAM-only — restart erases all room metadata
- No logs, no analytics, no persistence layer to exfiltrate

---

### 1.4 Network Observer (ISP, Router, MITM)

**What they can observe:**
- WebSocket traffic to signaling server (TLS encrypted)
- WebRTC DTLS handshake metadata
- IP addresses of peers (unless TURN relay is used)
- Traffic volume and timing patterns

**What they cannot observe:**
- Payload content (DTLS-SRTP encrypted)
- SDP content (WebSocket TLS encrypted)
- Room IDs (WebSocket TLS encrypted)

**Data at risk:**
- Traffic analysis: file size estimation from byte count
- Timing analysis: transfer duration reveals activity
- IP correlation: both peers' IPs visible if direct P2P

**Blast radius limitation:**
- Content encryption is mandatory (WebRTC default)
- No plaintext payload ever leaves browser unencrypted
- TURN relay (future) could hide peer IPs

---

### 1.5 Malicious Browser Extension

**What they can observe:**
- DOM state and JavaScript memory
- File content in streams (extension has page context access)
- All room IDs, meaning signals, connection state
- Potentially screen capture or input logging

**What they cannot observe:**
- Nothing — extension has full visibility

**Data at risk:**
- Everything — this is a compromised endpoint

**Blast radius limitation:**
- Ephera cannot protect against compromised browsers
- This is explicitly outside Ephera's threat model
- User must trust their browser environment

---

## 2. Memory Safety Analysis

### 2.1 User Data Memory Points

| Component | Data Location | Lifetime |
|-----------|---------------|----------|
| `EpheraTransport` | RTCDataChannel buffer | Chunk lifetime only |
| `EpheraSender` | ReadableStream reader | Single chunk at a time |
| `EpheraReceiver` | ReadableStream controller | Enqueued then released |
| `MeaningSender` | Local payload object | Destroyed after send |
| `MeaningReceiver` | Local meaning object | Passed to callback, not stored |
| `app.js` | File reference | Cleared immediately after stream extraction |

### 2.2 Destruction Guarantees

**Stream chunks:**
- Receiver enqueues chunk to controller, then releases reference
- No chunk array accumulation
- Constant-space behavior enforced

**File references:**
- `fileInput.value = ''` immediately after `file.stream()`
- File object becomes garbage-collectable

**Transport state:**
- `destroy()` nullifies all handlers and references
- RTCPeerConnection and RTCDataChannel explicitly closed
- Event listeners removed before close

**Meaning signals:**
- Sender auto-destroys after `send()`
- Receiver auto-destroys after `handle()`
- No getter to retrieve stored meaning

### 2.3 Why Recovery is Impossible

1. **No persistence layer exists** — there is no disk, database, or cache to recover from
2. **Garbage collection** — JavaScript runtime reclaims unreferenced memory
3. **Browser process isolation** — memory is not shared across origins
4. **No undo buffer** — streams are consumed, not replayed
5. **Session scoped** — all state dies with page unload

**Exception:** Browser memory forensics on running process could theoretically extract data. This requires physical access or kernel-level compromise — outside Ephera's threat model.

---

## 3. Failure Mode Analysis

### 3.1 Network Failure Mid-Stream

**Behavior:**
- WebRTC `iceconnectionstatechange` fires with `disconnected` or `failed`
- `transport.onClose` triggers `cleanup()`
- All references nullified
- Partial data on receiver side is abandoned (not accumulated)

**Data state:**
- Sender: stream cancelled, no retry
- Receiver: stream errored, no partial reconstruction

**Recovery:** Impossible — no state preserved

---

### 3.2 Browser Crash

**Behavior:**
- Process terminates
- All JavaScript heap destroyed
- No cleanup callbacks fire

**Data state:**
- All memory released by OS
- No persistence to survive crash

**Recovery:** Impossible — no crash recovery mechanism

---

### 3.3 Forced Reload (F5 / Ctrl+R)

**Behavior:**
- `window.onbeforeunload` fires `cleanup()`
- All connections closed
- Page reloads with fresh state

**Data state:**
- Previous session completely gone
- No session restoration

**Recovery:** Impossible — no session persistence

---

### 3.4 Tab Suspension (Browser Memory Saver)

**Behavior:**
- Browser may freeze tab and evict JS heap
- WebSocket and WebRTC connections may close
- On resume, connections are dead

**Data state:**
- Suspended tabs lose connection state
- No reconnection logic

**Recovery:** Impossible — reconnection not implemented by design

---

### 3.5 Signaling Server Restart

**Behavior:**
- All in-memory rooms destroyed
- All WebSocket connections close
- Clients receive `onclose` events

**Data state:**
- No room recovery
- No peer rediscovery
- Clients must create new rooms

**Recovery:** Impossible — server has no persistence

---

## 4. Guarantees

### 4.1 What Ephera Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| No server-side file storage | Server only handles signaling; bytes never touch server |
| No server-side logging of content | No logging code exists; manifesto prohibits it |
| No recovery after session end | RAM-only state; no persistence layer |
| No admin access to content | Content never reaches server; operator cannot intercept |
| End-to-end encryption | WebRTC DTLS-SRTP (browser-enforced) + optional passphrase encryption (AES-GCM per chunk) |
| Deterministic cleanup | Explicit `destroy()` paths; no lazy teardown |
| Ephemeral rooms | Waiting-room TTL enforced (0-1 peer); auto-destroy when empty |

### 4.2 What Ephera Does NOT Guarantee

| Non-Guarantee | Reason |
|---------------|--------|
| Prevention of receiver saving data locally | Outside Ephera's control |
| Protection against compromised browser/extensions | Endpoint security is user responsibility |
| Anonymity of IP addresses | Direct P2P exposes IPs (TURN not yet implemented) |
| Protection against traffic analysis | Byte counts and timing visible to network observers |
| Protection against physical memory forensics | Requires OS/hardware-level protection |
| Guaranteed delivery | No retries; network failures abandon transfer |
| Resume/retry of failed transfers | By design — no state to resume from |

---

## 5. Architecture Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                     EPHERA TRUST BOUNDARY                       │
│                                                                 │
│  ┌─────────────┐          ┌─────────────┐                       │
│  │   Sender    │◄────────►│  Receiver   │  (WebRTC P2P)         │
│  │   Browser   │          │   Browser   │                       │
│  └──────┬──────┘          └──────┬──────┘                       │
│         │                        │                              │
│         │    Signaling Only      │                              │
│         └──────────┬─────────────┘                              │
│                    ▼                                            │
│           ┌───────────────┐                                     │
│           │   Signaling   │  (Room IDs, SDP, ICE only)          │
│           │    Server     │  (No file bytes)                    │
│           │   (RAM only)  │  (No logs)                          │
│           └───────────────┘                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
         ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                              │
              OUTSIDE EPHERA'S CONTROL
                              │
         ┌────────────────────┴────────────────────┐
         │                                         │
    ┌────┴────┐    ┌──────────┐    ┌──────────────┴─┐
    │ Browser │    │ Network  │    │ Local Storage  │
    │ Plugins │    │ Observer │    │ (User Action)  │
    └─────────┘    └──────────┘    └────────────────┘
```

---

## 6. Summary

Ephera provides **transport-layer ephemerality** with **zero server-side persistence**.

It protects against:
- Operator surveillance
- Server compromise
- Post-session forensics (server-side)

It does not protect against:
- Malicious receivers saving data
- Compromised endpoints
- Traffic analysis
- IP exposure in P2P

The architecture enforces the manifesto's constraints through **absence of capability** — there is no persistence layer to subvert.
