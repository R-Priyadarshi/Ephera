/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEPLOY_DIR = path.join(ROOT, 'deploy');
const ENV_FILE = path.join(DEPLOY_DIR, '.env');
const COMPOSE_FILE = path.join(DEPLOY_DIR, 'docker-compose.turn.yml');

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function runCommand(cmd, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await canConnect(port)) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  throw new Error(`Timed out waiting for TURN port ${port}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
    s.once('error', reject);
  });
}

function validateTurnSecret(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('TURN_AUTH_SECRET is required in deploy/.env for dynamic relay gate.');
  }
  if (value === 'change-me-secret') {
    throw new Error('TURN_AUTH_SECRET in deploy/.env must not use the placeholder value "change-me-secret".');
  }
  if (value.length < 16) {
    throw new Error('TURN_AUTH_SECRET in deploy/.env must be at least 16 characters.');
  }
  return value;
}

function parseTurnTtlSeconds(raw) {
  const value = String(raw || '600').trim() || '600';
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error('TURN_TTL_SECONDS in deploy/.env must be a number between 30 and 86400.');
  }
  const ttl = Math.floor(n);
  if (ttl < 30 || ttl > 86400) {
    throw new Error('TURN_TTL_SECONDS in deploy/.env must be between 30 and 86400.');
  }
  return String(ttl);
}

async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`Missing ${ENV_FILE}. Copy deploy/turn.env.example to deploy/.env first.`);
  }
  if (!fs.existsSync(COMPOSE_FILE)) {
    throw new Error(`Missing ${COMPOSE_FILE}.`);
  }

  const fileEnv = parseDotEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  const turnHost = String(fileEnv.PUBLIC_TURN_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const turnSecret = validateTurnSecret(fileEnv.TURN_AUTH_SECRET);
  const turnTtl = parseTurnTtlSeconds(fileEnv.TURN_TTL_SECONDS);
  const turnPort = await getFreePort();

  const composeArgs = [
    'compose',
    '--env-file', ENV_FILE,
    '-f', COMPOSE_FILE,
  ];

  const composeEnv = {
    ...process.env,
    ...fileEnv,
    TURN_PORT: String(turnPort),
  };
  let downError = null;

  try {
    // Relay E2E only needs TURN reachable from the local browser process.
    await runCommand('docker', [...composeArgs, 'up', '-d', 'turn'], { env: composeEnv });
    await waitForPort(turnPort, 120_000);

    await runCommand('npm', ['run', 'e2e:relay:required'], {
      env: {
        ...process.env,
        E2E_TURN_URL: `turn:${turnHost}:${turnPort}?transport=udp`,
        E2E_TURN_URL_TCP: `turn:${turnHost}:${turnPort}?transport=tcp`,
        E2E_TURN_AUTH_SECRET: turnSecret,
        E2E_TURN_TTL_SECONDS: turnTtl,
      },
    });
  } finally {
    try {
      await runCommand('docker', [...composeArgs, 'down'], { env: composeEnv });
    } catch (err) {
      downError = err;
    }
  }

  if (downError) throw downError;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
