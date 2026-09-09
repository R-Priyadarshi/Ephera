const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // Mobile viewport
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  
  // Wait for localhost:3000 to be available
  console.log('Navigating to landing page...');
  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'landing-mobile.png', fullPage: true });

  console.log('Navigating to dashboard...');
  await page.goto('http://localhost:3000/?mode=dashboard'); // Assuming dashboard can be accessed directly this way, otherwise click "Launch Dashboard"
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'dashboard-mobile.png', fullPage: true });

  console.log('Done screenshots.');
  await browser.close();
})();
