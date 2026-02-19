/**
 * EPHERA — Stateless Signaling Server (CLI)
 *
 * ZERO-MEMORY GUARANTEES:
 * - No disk writes
 * - No persistent logs
 * - No payload inspection
 * - No recovery
 * - All state lives only in RAM
 * - Process death = total amnesia
 */

const { createSignalingServer } = require('./signaling');

const rawPort = Number(process.env.PORT || 8080);
const port = Number.isFinite(rawPort) ? rawPort : 8080;
const host = (typeof process.env.HOST === 'string' && process.env.HOST.trim())
  ? process.env.HOST.trim()
  : '0.0.0.0';

const server = createSignalingServer({ port, host });

// If the port is already in use (or other listen errors),
// fail deterministically without printing payload-related diagnostics.
server.wss.on('error', () => {
  process.exit(1);
});

/**
 * Deterministic amnesia on process exit
 */
const shutdown = async () => {
  try { await server.close(); } catch {}
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Intentionally silent.
 * If Ephera logs, Ephera remembers.
 */
