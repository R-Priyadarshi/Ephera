/**
 * EPHERA — WebRTC Transport Core (Canonical)
 *
 * ZERO-MEMORY GUARANTEES:
 * - Frame streaming only (no full buffers)
 * - No persistence
 * - No logs / metrics
 * - Deterministic teardown
 * - Safe under concurrent senders
 */

// Pause sending when buffer exceeds this threshold
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024;

// Resume sending when buffer drops below this threshold
const BUFFER_LOW_THRESHOLD = 2 * 1024 * 1024;

class EpheraTransport {
  constructor(signaling, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }], rtcConfig = null) {
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.rtcConfig = (() => {
      // Only accept a small safe subset of RTCPeerConnection config options.
      // (No persistence; no side channels; avoids passing through unknown objects.)
      if (!rtcConfig || typeof rtcConfig !== 'object') return null;
      const out = {};

      if (rtcConfig.iceTransportPolicy === 'relay') out.iceTransportPolicy = 'relay';
      if (rtcConfig.iceTransportPolicy === 'all') out.iceTransportPolicy = 'all';

      return Object.keys(out).length ? out : null;
    })();

    this.pc = null;
    this.channel = null;

    this.destroyed = false;

    // Serialize channel.send calls so backpressure cannot be bypassed by concurrency.
    // This also guarantees O(1) in-flight frame per active sender (sendStream awaits send()).
    this._sendTail = Promise.resolve();

    // Backpressure resume callback (at most one due to send serialization).
    this._resumeSend = null;

    // Optional test harness hook (loopback mode)
    // eslint-disable-next-line no-unused-vars
    this.onSend = null;

    // Multi-listener event model (no component may "steal" transport callbacks)
    this._listeners = {
      open: new Set(),
      close: new Set(),
      error: new Set(),
      chunk: new Set(),
      state: new Set(),
    };

    // Backwards-compatible single callbacks (used by app.js / tests)
    this.onChunk = null;
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onState = null;

    // Stage 4: Fair scheduling across concurrent sendStream() calls.
    this._producers = [];
    this._totalWeight = 0;
    this._schedulerRunning = false;

    // Stage 5-ish hardening: ICE candidates can arrive before remoteDescription.
    // Queue in memory only; drained as soon as remoteDescription is set.
    this._pendingIce = [];

    // Stage 5: transient disconnect is normal on some networks.
    // Avoid immediate teardown; allow recovery before destroy.
    this._iceBadTimer = null;
  }

  /* ---------------- Event API ---------------- */

  addEventListener(type, handler) {
    const set = this._listeners[type];
    if (!set || !handler) return;
    set.add(handler);
  }

  removeEventListener(type, handler) {
    const set = this._listeners[type];
    if (!set || !handler) return;
    set.delete(handler);
  }

  _emit(type, payload) {
    // Single callback (compat)
    try {
      switch (type) {
        case 'open':
          if (this.onOpen) this.onOpen(payload);
          break;
        case 'close':
          if (this.onClose) this.onClose(payload);
          break;
        case 'error':
          if (this.onError) this.onError(payload);
          break;
        case 'chunk':
          if (this.onChunk) this.onChunk(payload);
          break;
        case 'state':
          if (this.onState) this.onState(payload);
          break;
      }
    } catch {
      // Callbacks must never break transport
    }

    const set = this._listeners[type];
    if (!set) return;

    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        // Listener failure must never break transport
      }
    }
  }

  /* ---------------- Session Lifecycle ---------------- */

  async createOffer({ iceRestart = false } = {}) {
    this._initPeerConnection();
    // Only the offerer creates the DataChannel. Never create multiple channels.
    if (!this.channel) this._createDataChannel();

    const offer = await this.pc.createOffer({ iceRestart: !!iceRestart });
    await this.pc.setLocalDescription(offer);

    return offer;
  }

  async handleOffer(offer) {
    this._initPeerConnection();

    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this._bindChannel();
    };

    await this.pc.setRemoteDescription(offer);
    await this._drainPendingIce();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    return answer;
  }

  async handleAnswer(answer) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
    await this._drainPendingIce();
  }

  async addIceCandidate(candidate) {
    if (this.destroyed) return;
    if (!candidate) return;

    // Candidate can arrive before pc exists or before remoteDescription is set.
    if (!this.pc || !this.pc.remoteDescription) {
      if (this._pendingIce.length < 512) this._pendingIce.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // Some browsers throw if candidates arrive before descriptions are fully applied.
      // Queue and retry on next drain.
      if (this._pendingIce.length < 512) this._pendingIce.push(candidate);
    }
  }

  /**
   * Loopback transport open (test harness)
   *
   * This intentionally avoids WebRTC and simply marks the transport as open.
   * Tests can wire two transports together via `onSend` + `_handleIncoming`.
   */
  async open() {
    if (this.destroyed) throw new Error('Transport destroyed');
    if (this.channel && this.channel.readyState === 'open') return;

    // Minimal "channel" surface used by send()
    this.channel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: BUFFER_LOW_THRESHOLD,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      onbufferedamountlow: null,
      binaryType: 'arraybuffer',
      close: () => {
        if (!this.channel) return;
        this.channel.readyState = 'closed';
      },
      send: (data) => {
        if (this.onSend) {
          this.onSend(data);
        }
      },
    };

    this._emit('open');
  }

  /**
   * Send a single framed message.
   *
   * IMPORTANT:
   * - Transport does NOT split frames.
   * - Framing/chunking belongs to the protocol layer (sender.js).
   */
  async send(frame) {
    return this._enqueueSend(async () => {
      if (this.destroyed || !this.channel || this.channel.readyState !== 'open') {
        throw new Error('Channel not open');
      }

      if (!(frame instanceof Uint8Array)) {
        throw new Error('Frame must be Uint8Array');
      }

      await this._waitForBackpressure();

      if (this.destroyed || !this.channel || this.channel.readyState !== 'open') {
        throw new Error('Connection closed during send');
      }

      try {
        this.channel.send(frame);
      } catch (err) {
        this._emit('error', err);
        this.destroy();
        throw err;
      }
    });
  }

  /* ---------------- Streaming API (SAFE) ---------------- */

  async sendStream(readableStream, { weight = 1 } = {}) {
    if (this.destroyed) throw new Error('Transport destroyed');
    if (!readableStream || typeof readableStream.getReader !== 'function') {
      throw new Error('Valid ReadableStream required');
    }

    const w = Number.isFinite(weight) ? Math.max(1, Math.floor(weight)) : 1;
    const reader = readableStream.getReader();

    return new Promise((resolve, reject) => {
      const producer = {
        reader,
        weight: w,
        current: 0,
        pending: null,
        done: false,
        error: null,
        readPromise: null,
        resolve,
        reject,
      };

      this._producers.push(producer);
      this._recalcTotalWeight();
      this._ensureProducerRead(producer);
      this._startScheduler();
    });
  }

  /* ---------------- Cleanup ---------------- */

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this._iceBadTimer) {
      clearTimeout(this._iceBadTimer);
      this._iceBadTimer = null;
    }

    // Release pending backpressure wait.
    if (this._resumeSend) {
      const resume = this._resumeSend;
      this._resumeSend = null;
      try { resume(); } catch {}
    }

    // Abort all active producers (sendStream callers)
    if (this._producers.length > 0) {
      const producers = this._producers;
      this._producers = [];
      this._totalWeight = 0;
      for (const p of producers) {
        try { p.reader.releaseLock(); } catch {}
        try { p.reject(new Error('Transport destroyed')); } catch {}
      }
    }

    if (this.channel) {
      try {
        this.channel.onopen = null;
        this.channel.onclose = null;
        this.channel.onerror = null;
        this.channel.onmessage = null;
        this.channel.onbufferedamountlow = null;
        this.channel.close();
      } catch {}
      this.channel = null;
    }

    if (this.pc) {
      try {
        this.pc.onicecandidate = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.ondatachannel = null;
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    this.signaling = null;
    this.onSend = null;
    this.onChunk = null;
    this.onOpen = null;
    this.onClose = null;
    this.onError = null;
    this.onState = null;

    this._listeners.open.clear();
    this._listeners.close.clear();
    this._listeners.error.clear();
    this._listeners.chunk.clear();
    this._listeners.state.clear();

    this._pendingIce.length = 0;
  }

  /* ---------------- Internals ---------------- */

  _initPeerConnection() {
    if (this.pc) return;

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(this.rtcConfig || null),
    });

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.signaling) {
        this.signaling.sendCandidate(e.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this._emit('state', { iceConnectionState: state });

      if (this._iceBadTimer) {
        clearTimeout(this._iceBadTimer);
        this._iceBadTimer = null;
      }

      // "disconnected" can be transient (wifi roam, brief network flap).
      // Give it time to recover before teardown.
      if (state === 'disconnected') {
        this._iceBadTimer = setTimeout(() => {
          if (this.destroyed || !this.pc) return;
          const s = this.pc.iceConnectionState;
          if (s === 'disconnected') {
            this._emit('close');
            this.destroy();
          }
        }, 10_000);
        return;
      }

      // "failed" usually requires ICE restart. If the app doesn't recover,
      // tear down deterministically after a short grace window.
      if (state === 'failed') {
        this._iceBadTimer = setTimeout(() => {
          if (this.destroyed || !this.pc) return;
          const s = this.pc.iceConnectionState;
          if (s === 'failed') {
            this._emit('close');
            this.destroy();
          }
        }, 3_000);
        return;
      }

      if (state === 'closed') {
        this._emit('close');
        this.destroy();
      }
    };
  }

  async _drainPendingIce() {
    if (this.destroyed) return;
    if (!this.pc || !this.pc.remoteDescription) return;
    if (this._pendingIce.length === 0) return;

    const pending = this._pendingIce;
    this._pendingIce = [];

    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        // Ignore un-addable candidates; never throw in drain.
      }
    }
  }

  _createDataChannel() {
    this.channel = this.pc.createDataChannel('ephera', {
      ordered: true,
      protocol: 'binary',
    });

    this._bindChannel();
  }

  _bindChannel() {
    this.channel.binaryType = 'arraybuffer';

    // Set threshold for onbufferedamountlow event
    this.channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    this.channel.onopen = () => {
      this._emit('open');
    };

    this.channel.onclose = () => {
      this._emit('close');
      this.destroy();
    };

    this.channel.onerror = (err) => {
      this._emit('error', err);
      this.destroy();
    };

    // Resume sending when buffer drains below threshold
    this.channel.onbufferedamountlow = () => {
      if (this._resumeSend) {
        const resume = this._resumeSend;
        this._resumeSend = null;
        resume();
      }
    };

    this.channel.onmessage = (e) => {
      const data = e.data instanceof Uint8Array
        ? e.data
        : new Uint8Array(e.data);
      this._emit('chunk', data);
    };
  }

  _waitForBackpressure() {
    // Resolve immediately if buffer is safe
    if (this.destroyed || !this.channel) {
      return Promise.resolve();
    }

    if (this.channel.bufferedAmount < BUFFER_HIGH_WATERMARK) {
      return Promise.resolve();
    }

    // Buffer full — wait for onbufferedamountlow event
    return new Promise((resolve) => {
      this._resumeSend = resolve;
    });
  }

  _enqueueSend(fn) {
    // Keep queue alive even if a send fails.
    const run = () => fn();
    const next = this._sendTail.then(run, run);
    this._sendTail = next.catch(() => { });
    return next;
  }

  /* ---------------- Stage 4: Scheduler ---------------- */

  _recalcTotalWeight() {
    let total = 0;
    for (const p of this._producers) total += p.weight;
    this._totalWeight = total;
  }

  _ensureProducerRead(p) {
    if (!p || p.pending || p.done || p.error || p.readPromise) return;

    p.readPromise = p.reader.read().then(({ done, value }) => {
      p.readPromise = null;
      if (done) {
        p.done = true;
        return;
      }

      p.pending = value instanceof Uint8Array ? value : new Uint8Array(value);
    }).catch((err) => {
      p.readPromise = null;
      p.error = err || new Error('Stream read failed');
    });
  }

  _startScheduler() {
    if (this._schedulerRunning) return;
    this._schedulerRunning = true;
    this._runScheduler().finally(() => {
      this._schedulerRunning = false;
    });
  }

  async _runScheduler() {
    // When only one producer is momentarily sendable, a single microtask yield
    // helps other in-flight reads settle so weights can influence selection.
    // This must be bounded to avoid deadlock if a readPromise stalls.
    let yieldedForInFlight = false;

    while (!this.destroyed && this._producers.length > 0) {
      // Ensure all producers have at most one pending read.
      for (const p of this._producers) {
        this._ensureProducerRead(p);
      }

      // Finalize any producers that are done or errored.
      for (let i = this._producers.length - 1; i >= 0; i--) {
        const p = this._producers[i];

        if (p.error) {
          this._producers.splice(i, 1);
          this._recalcTotalWeight();
          try { p.reader.releaseLock(); } catch {}
          try { p.reject(p.error); } catch {}
          continue;
        }

        if (p.done && !p.pending) {
          this._producers.splice(i, 1);
          this._recalcTotalWeight();
          try { p.reader.releaseLock(); } catch {}
          try { p.resolve(); } catch {}
        }
      }

      if (this._producers.length === 0) break;

      // Find producers that have a pending frame ready to send.
      const sendable = [];
      for (const p of this._producers) {
        if (p.pending) sendable.push(p);
      }

      // If only one producer is sendable but others are in-flight, yield exactly once.
      if (sendable.length === 1 && this._producers.length > 1) {
        let hasInFlight = false;
        for (const p of this._producers) {
          if (!p.pending && p.readPromise) {
            hasInFlight = true;
            break;
          }
        }
        if (hasInFlight && !yieldedForInFlight) {
          yieldedForInFlight = true;
          await Promise.resolve();
          continue;
        }
      }

      yieldedForInFlight = false;

      if (sendable.length === 0) {
        // No frames ready: wait until any producer read completes.
        const reads = [];
        for (const p of this._producers) {
          if (p.readPromise) reads.push(p.readPromise);
        }
        if (reads.length === 0) {
          // Should not happen, but avoid tight spin.
          await new Promise((r) => setTimeout(r, 0));
        } else {
          await Promise.race(reads);
        }
        continue;
      }

      // Smooth Weighted Round Robin selection among sendable producers.
      for (const p of this._producers) {
        p.current += p.weight;
      }

      let chosen = null;
      for (const p of sendable) {
        if (!chosen || p.current > chosen.current) chosen = p;
      }

      if (!chosen) continue;
      chosen.current -= this._totalWeight;

      const frame = chosen.pending;
      chosen.pending = null;

      // Send one frame, respecting backpressure and serialization.
      await this.send(frame);
    }
  }

  /**
   * Loopback receive (test harness)
   */
  _handleIncoming(data) {
    if (this.destroyed) return;
    const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._emit('chunk', frame);
  }
}

export { EpheraTransport };
