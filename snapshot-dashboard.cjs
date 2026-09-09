const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // Mobile viewport
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  
  console.log('Navigating to premium dashboard...');
  await page.goto('http://localhost:5174');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'premium-dashboard-mobile.png', fullPage: true });

  console.log('Done screenshot.');
  await browser.close();
})();
