/* eslint-disable no-console */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const VIEWPORTS = [320, 360, 390, 430, 768];
const SCREENSHOTS = /^(1|true)$/i.test(process.env.E2E_MOBILE_SCREENSHOTS || '');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function waitForReady(url, timeoutMs = 10_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) throw new Error('Chrome/Chromium not found. Set CHROME_PATH.');
  return chromePath;
}

async function readLayout(page, mode) {
  return page.evaluate((pageMode) => {
    const tolerance = 1;
    const visible = (element) => {
      if (element.closest('details:not([open]) > :not(summary)')) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const describe = (element) => {
      const label = element.getAttribute('aria-label')
        || element.id
        || String(element.className || '').trim()
        || element.tagName.toLowerCase();
      return label.replace(/\s+/g, ' ').slice(0, 100);
    };
    const viewportWidth = window.innerWidth;
    const outOfBounds = [...document.querySelectorAll('body *')]
      .filter(visible)
      .filter((element) => !element.closest('[aria-hidden="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -tolerance || rect.right > viewportWidth + tolerance;
      })
      .map(describe);
    const shortTargets = [...document.querySelectorAll('button, a[href], details > summary')]
      .filter(visible)
      .filter((element) => element.getBoundingClientRect().height < 43.5)
      .map((element) => `${describe(element)} (${element.getBoundingClientRect().height.toFixed(1)}px)`);

    const overlapPairs = [];
    const checkSiblingOverlaps = (selector) => {
      const parent = document.querySelector(selector);
      if (!parent || !visible(parent)) return;
      const children = [...parent.children].filter(visible);
      for (let first = 0; first < children.length; first += 1) {
        for (let second = first + 1; second < children.length; second += 1) {
          const a = children[first].getBoundingClientRect();
          const b = children[second].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > tolerance && overlapY > tolerance) {
            overlapPairs.push(`${describe(children[first])} <> ${describe(children[second])}`);
          }
        }
      }
    };

    if (pageMode === 'landing') {
      checkSiblingOverlaps('#landing-react-root main');
    } else {
      checkSiblingOverlaps('#dashboard-shell');
      checkSiblingOverlaps('.phase-rail');
      checkSiblingOverlaps('.transfer-grid');
      checkSiblingOverlaps('.workspace-column-side');
    }

    const clipped = [];
    if (pageMode === 'dashboard') {
      for (const selector of [
        '.workspace-command-deck',
        '.workspace-layout',
        '.phase-rail',
        '.operator-console-summary',
        '#send-card',
      ]) {
        const element = document.querySelector(selector);
        if (element && element.scrollWidth > element.clientWidth + tolerance) {
          clipped.push(`${selector} (${element.clientWidth}/${element.scrollWidth})`);
        }
      }
      for (const label of document.querySelectorAll('.phase-node-label')) {
        const node = label.closest('.phase-node');
        const labelRect = label.getBoundingClientRect();
        const nodeRect = node && node.getBoundingClientRect();
        if (nodeRect && (labelRect.left < nodeRect.left - tolerance || labelRect.right > nodeRect.right + tolerance)) {
          clipped.push(`phase label outside card: ${label.textContent.trim()}`);
        }
      }
    }

    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      outOfBounds: [...new Set(outOfBounds)],
      shortTargets: [...new Set(shortTargets)],
      overlapPairs: [...new Set(overlapPairs)],
      clipped,
    };
  }, mode);
}

function assertLayout(report, label) {
  assert.strictEqual(
    report.documentWidth,
    report.viewportWidth,
    `${label}: document is ${report.documentWidth}px wide in a ${report.viewportWidth}px viewport`,
  );
  assert.deepStrictEqual(report.outOfBounds, [], `${label}: elements outside viewport`);
  assert.deepStrictEqual(report.overlapPairs, [], `${label}: sibling collisions`);
  assert.deepStrictEqual(report.clipped, [], `${label}: clipped critical containers`);
  assert.deepStrictEqual(report.shortTargets, [], `${label}: touch targets below 44px`);
}

async function assertVisible(page, selectors, label) {
  for (const selector of selectors) {
    const element = page.locator(selector).first();
    assert(await element.isVisible(), `${label}: ${selector} is missing or hidden`);
  }
}

async function runViewport(browser, baseUrl, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#hero h1').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await assertVisible(page, [
      '#hero',
      '#pipeline',
      '#how-to-use',
      '#architecture',
      '#preview',
      '#preview [aria-label="Dashboard preview sections"]',
      '#principles',
      '#trust',
      '.landing-footer',
    ], `landing ${width}px`);
    assertLayout(await readLayout(page, 'landing'), `landing ${width}px`);

    if (SCREENSHOTS) {
      await page.screenshot({ path: path.join(ROOT, 'output', 'playwright', `landing-${width}.png`), fullPage: true });
    }

    await page.locator('#hero').getByRole('button', { name: 'Launch Dashboard' }).click();
    await page.locator('.app-shell-dashboard').waitFor({ state: 'visible' });
    await assertVisible(page, [
      '.workspace-header',
      '.workspace-spotlight',
      '.workspace-command-deck',
      '#room-controls',
      '#operator-console',
      '#transfer-controls',
      '#receive-card',
      '#send-card',
      '#transfer-advanced',
      '#flow-guide',
      '#preflight-panel',
      '#transfer-ledger-list',
      '#activity-timeline',
      '.footer',
    ], `dashboard ${width}px`);

    await page.evaluate(() => {
      document.querySelector('#qr-pairing-panel').open = true;
    });
    if (width === VIEWPORTS[0]) {
      await page.locator('#launchpad-host').click();
      await page.waitForFunction(() => document.querySelector('#room-id').value.length > 20);
      await page.locator('#show-invite-qr').click();
      await page.locator('#invite-qr-canvas').waitFor({ state: 'visible' });
      for (const selector of ['#room-id', '#room-join-key', '#join-link', '#passphrase']) {
        assert((await page.locator(selector).inputValue()).length > 20, `${selector} was not generated`);
      }
    }

    assertLayout(await readLayout(page, 'dashboard'), `dashboard ${width}px`);
    if (SCREENSHOTS) {
      await page.screenshot({ path: path.join(ROOT, 'output', 'playwright', `dashboard-${width}.png`), fullPage: true });
    }
    assert.deepStrictEqual(consoleErrors, [], `${width}px browser console errors`);
    console.log(`PASS mobile layout ${width}px`);
  } finally {
    await context.close();
  }
}

async function run() {
  const port = await getFreePort();
  const app = spawn(process.execPath, [path.join(ROOT, 'server', 'serve.js')], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), VERBOSE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appErrors = '';
  app.stderr.on('data', (chunk) => { appErrors += String(chunk); });
  let browser;

  try {
    await waitForReady(`http://127.0.0.1:${port}/readyz`);
    browser = await chromium.launch({ headless: true, executablePath: findChrome() });
    for (const width of VIEWPORTS) {
      // Keep each viewport isolated so generated session credentials cannot leak between cases.
      // eslint-disable-next-line no-await-in-loop
      await runViewport(browser, `http://127.0.0.1:${port}/`, width);
    }
    console.log('PASS all mobile landing and dashboard layout gates');
  } finally {
    if (browser) await browser.close();
    app.kill('SIGTERM');
  }

  if (appErrors.trim()) console.error(appErrors.trim());
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
