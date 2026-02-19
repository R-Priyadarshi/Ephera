# EPHERA — Performance Hardening Checklist

**Document Type:** Engineering Checklist  
**Scope:** Manual verification gates  
**Constraint:** No logging, no persistent metrics, no instrumentation libraries

---

## Gate 1: Memory Stability

## Automated Regression Coverage (Does Not Replace Manual Gates)

The repo includes automated E2E regressions (`npm run e2e`) that cover parts of this checklist:

- Signaling server crash mid-transfer (active P2P must continue)
- Sender tab close mid-transfer (receiver must abort deterministically; no hang)
- Repeated connect/disconnect cycles without reload (basic stability)
- Forced-GC session collectability gate (catches obvious `TransferSession` reference leaks)
- Secure runtime gate (HTTPS/WSS via `dev-secure.js`, self-signed cert path)
- Folder-save flow gate via `showDirectoryPicker` polyfill (saved receipt + byte-integrity verification)
- Optional perf gate (`npm run e2e:perf`): 100MB transfer with heap + `bufferedAmount` sampling (automated approximation)

These checks reduce risk, but **they do not replace** the manual verification steps below for release.

Optional longer-running automated approximations:

- `npm run e2e:soak`: idle-connection + extra connect/disconnect cycles (no reload)
- `npm run e2e:perf`: 100MB transfer + heap/buffer sampling

### 1.1 Single Transfer Memory Baseline

**Scenario:**  
Transfer a 100MB file between two peers.

**Observation method:**  
Browser DevTools → Memory tab → Heap snapshot before and after transfer.

**What to observe:**
- Heap size during transfer
- Heap size after transfer completion
- Presence of detached DOM nodes or retained ArrayBuffers

**Pass criteria:**
- Heap during transfer stays within 2× chunk buffer threshold (~2MB above baseline)
- Heap after transfer returns to within 10% of pre-transfer baseline
- No retained ArrayBuffer or Uint8Array objects in post-transfer snapshot

**Fail criteria:**
- Heap grows linearly with file size during transfer
- Heap does not return to baseline after completion
- ArrayBuffer objects persist after `destroy()` calls

---

### 1.2 Repeated Transfer Memory Stability

**Scenario:**  
Transfer 10× 50MB files sequentially (same session, no reload).

**Observation method:**  
Heap snapshot after each transfer completes.

**What to observe:**
- Heap size trend across 10 transfers
- Object retention patterns

**Pass criteria:**
- Heap size after each transfer is within 15% of baseline
- No monotonic growth trend
- GC reclaims all transfer-related objects between runs

**Fail criteria:**
- Heap grows with each transfer
- Objects from transfer N visible in snapshot after transfer N+1

---

### 1.3 Receiver Stream Memory

**Scenario:**  
Receive a 500MB file (simulated slow consumer: artificial 10ms delay per chunk read).

**Observation method:**  
Memory tab → Allocation timeline during transfer.

**What to observe:**
- Allocation pattern (should be flat, not accumulating)
- ReadableStream internal queue size

**Pass criteria:**
- Memory allocation is constant-space (sawtooth pattern: allocate, GC, repeat)
- No large contiguous allocations

**Fail criteria:**
- Memory grows linearly with received bytes
- Single large allocation visible

---

## Gate 2: Backpressure Correctness

### 2.1 Sender Backpressure Under Slow Receiver

**Scenario:**  
Sender transmits 200MB. Receiver artificially delays `reader.read()` by 50ms per chunk.

**Observation method:**  
Observe `channel.bufferedAmount` in sender (via breakpoint or console in dev build only).

**What to observe:**
- `bufferedAmount` value during transfer
- Whether sender pauses when threshold exceeded

**Pass criteria:**
- `bufferedAmount` never exceeds `BUFFER_HIGH_WATERMARK` (~4MB) by more than 1 chunk
- Sender waits when buffer is full
- No data loss

**Fail criteria:**
- `bufferedAmount` grows unbounded
- Browser memory spikes due to buffering
- Data channel closes unexpectedly

---

### 2.2 Fast Sender / Saturated Network

**Scenario:**  
Transfer 100MB over throttled network (DevTools → Network → Slow 3G).

**Observation method:**  
Memory and Performance tabs during transfer.

**What to observe:**
- Sender memory stability
- Transfer completes without error
- No browser freeze or unresponsive script

**Pass criteria:**
- Sender memory stays bounded
- Transfer completes (may be slow)
- UI remains responsive

**Fail criteria:**
- Sender memory grows during throttled transfer
- Browser becomes unresponsive
- Transfer fails with buffer-related error

---

### 2.3 Receiver Backpressure Propagation

**Scenario:**  
Receiver's stream consumer stops reading entirely (simulate stalled consumer).

**Observation method:**  
Observe sender behavior after 5 seconds of stalled receiver.

**What to observe:**
- Does sender detect backpressure?
- Does data channel remain stable?

**Pass criteria:**
- Sender pauses or transfer stalls gracefully
- No memory explosion on either side
- Connection remains open (no unexpected close)

**Fail criteria:**
- Sender continues sending into void
- Buffer overflow causes crash or close
- Memory grows on sender or receiver

---

## Gate 3: Failure Behavior

### 3.1 Mid-Transfer Network Disconnect

**Scenario:**  
Start 200MB transfer. At 50% progress, disable network (DevTools → Network → Offline).

**Observation method:**  
Observe both sender and receiver state after disconnect.

**What to observe:**
- `onClose` or `onError` fires on both sides
- `destroy()` is called
- Memory returns to baseline

**Pass criteria:**
- Both peers detect disconnect within 10 seconds
- All references cleaned up
- No orphan streams or connections

**Fail criteria:**
- One side does not detect disconnect
- Memory leak after disconnect
- Orphan RTCPeerConnection remains

---

### 3.2 Signaling Server Crash Mid-Session

**Scenario:**  
Establish transfer. Kill signaling server process during active transfer.

**Observation method:**  
Observe peer behavior.

**What to observe:**
- Does active WebRTC transfer continue? (It should — P2P is established)
- Does new signaling fail gracefully?
- Does the UI indicate signaling loss without killing the P2P session?

**Pass criteria:**
- Active transfer completes (signaling not needed after connection)
- No crash on client
- Subsequent room creation fails gracefully
- UI shows signaling is disconnected while P2P remains active

**Fail criteria:**
- Active transfer fails due to signaling loss
- Client crashes or hangs

---

### 3.3 Tab Close Mid-Transfer

**Scenario:**  
Start transfer. Close sender tab at 25% progress.

**Observation method:**  
Observe receiver state.

**What to observe:**
- Does receiver detect peer loss?
- Does receiver clean up?

**Pass criteria:**
- Receiver fires `onClose` within 5 seconds
- Receiver calls `destroy()`
- No memory retention on receiver

**Fail criteria:**
- Receiver hangs waiting for data
- Receiver does not clean up
- Memory leak

---

### 3.4 Browser Crash Simulation

**Scenario:**  
Start transfer. Kill browser process via OS task manager.

**Observation method:**  
Observe signaling server (if accessible) and peer.

**What to observe:**
- Does signaling server detect disconnect?
- Does room auto-destroy?
- Does peer detect loss?

**Pass criteria:**
- Server removes disconnected socket
- Room destroys when empty
- Peer detects loss and cleans up

**Fail criteria:**
- Room persists after crash
- Peer does not detect loss

---

## Gate 4: Long-Session Stability

### 4.1 Idle Connection Stability

**Scenario:**  
Establish connection. Leave idle for 30 minutes. Then transfer 10MB.

**Observation method:**  
Observe connection state after idle period.

**What to observe:**
- Is connection still alive?
- Does transfer succeed?

**Pass criteria:**
- Connection remains open (or gracefully reconnectable)
- Transfer succeeds after idle
- No memory growth during idle

**Fail criteria:**
- Connection silently dies
- Transfer fails after idle
- Memory grows during idle

---

### 4.2 Repeated Connect/Disconnect Cycles

**Scenario:**  
Create room → join → transfer 1MB → disconnect → repeat 20 times.

**Observation method:**  
Memory snapshot after cycle 1, 10, and 20.

**What to observe:**
- Memory trend
- WebSocket/RTCPeerConnection cleanup

**Pass criteria:**
- Memory at cycle 20 is within 20% of cycle 1
- No accumulation of connections in DevTools
- No retained event listeners

**Fail criteria:**
- Memory grows with each cycle
- DevTools shows accumulating connections
- Event listener count grows

---

### 4.3 Room TTL Enforcement

**Scenario:**  
Create room (single peer only; no second peer joins). Wait for TTL (10 minutes).

**Observation method:**  
Observe signaling server (if accessible) or attempt to join after TTL.

**What to observe:**
- Does waiting room auto-destroy at TTL?
- Does late join fail gracefully?

**Pass criteria:**
- Room is destroyed at TTL
- Late join returns "Room not found"
- Server memory stable

**Fail criteria:**
- Room persists past TTL
- Server memory leak from orphan rooms

---

## Observation Constraints

| Allowed | Prohibited |
|---------|------------|
| Browser DevTools Memory tab | `console.log` with payload data |
| Browser DevTools Performance tab | Persistent metrics collection |
| Manual breakpoints | Instrumentation libraries |
| Heap snapshots | APM tools |
| Allocation timelines | Server-side logging |
| Process monitor (OS-level) | Analytics |

---

## Exit Criteria

All four gates must pass before any release:

| Gate | Status |
|------|--------|
| Memory Stability | ☐ |
| Backpressure Correctness | ☐ |
| Failure Behavior | ☐ |
| Long-Session Stability | ☐ |

A single fail in any gate blocks release until resolved.
