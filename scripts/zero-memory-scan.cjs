#!/usr/bin/env node
/**
 * Ephera — Zero-Memory Compliance Scan (Automation)
 *
 * Purpose:
 * - Catch accidental introduction of persistence APIs in the browser client.
 * - Catch accidental disk write operations in the signaling/app server.
 *
 * This is a lightweight guardrail, not a formal audit.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TARGETS = [
  { name: 'client', dir: path.join(ROOT, 'client') },
  { name: 'server', dir: path.join(ROOT, 'server'), ignoreRelPrefixes: ['server/test/'] },
];

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.ephera-dev-tls',
]);

const TEXT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.css',
]);

function isTextPath(p) {
  const ext = path.extname(p).toLowerCase();
  return TEXT_EXTS.has(ext);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(full, out);
      continue;
    }

    if (!ent.isFile()) continue;
    if (!isTextPath(full)) continue;
    out.push(full);
  }
}

const RULES = [
  {
    id: 'browser-persistence',
    targets: new Set(['client']),
    re: /\b(localStorage|sessionStorage|indexedDB|openDatabase|CacheStorage|serviceWorker|navigator\.serviceWorker|caches)\b/g,
    message: 'Browser persistence API found (violates zero-memory posture).',
  },
  {
    id: 'server-disk-write',
    targets: new Set(['server']),
    re: /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdir|mkdtempSync|mkdtemp|renameSync|rename|unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir)\b/g,
    message: 'Potential disk write API found in server code (should remain RAM-only).',
  },
  {
    id: 'server-fs-promises-write',
    targets: new Set(['server']),
    re: /\bfs\.promises\.(writeFile|appendFile|mkdir|mkdtemp|rename|unlink|rm|rmdir)\b/g,
    message: 'Potential fs.promises disk write API found in server code (should remain RAM-only).',
  },
];

function scanFile(filePath, targetName) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const hits = [];
  for (const rule of RULES) {
    if (!rule.targets.has(targetName)) continue;
    rule.re.lastIndex = 0;
    const m = rule.re.exec(text);
    if (!m) continue;
    hits.push({
      ruleId: rule.id,
      message: rule.message,
      match: m[0],
    });
  }
  return hits;
}

function main() {
  const findings = [];

  for (const t of TARGETS) {
    const files = [];
    walk(t.dir, files);

    for (const filePath of files) {
      const rel = path.relative(ROOT, filePath);
      if (Array.isArray(t.ignoreRelPrefixes) && t.ignoreRelPrefixes.some((prefix) => rel.startsWith(prefix))) {
        continue;
      }
      const hits = scanFile(filePath, t.name);
      for (const h of hits) {
        findings.push({ file: rel, ...h });
      }
    }
  }

  if (findings.length === 0) {
    process.stdout.write('zero-memory scan: OK\n');
    process.exit(0);
  }

  process.stderr.write('zero-memory scan: FAIL\n');
  for (const f of findings) {
    process.stderr.write(`- ${f.file}: ${f.ruleId} (${f.match}) — ${f.message}\n`);
  }
  process.exit(1);
}

main();
