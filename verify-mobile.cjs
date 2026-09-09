const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 } // Mobile view
  });
  const page = await context.newPage();
  
  console.log('Navigating to dashboard...');
  await page.goto('http://localhost:5174/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.querySelector('#open-dashboard')?.click());
  await page.waitForTimeout(1000);
  
  // Check for horizontal overflow
  const layoutMetrics = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewWidth = window.innerWidth;
    
    // Find all elements that might be causing overflow
    const overflowElements = [];
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > viewWidth) {
        overflowElements.push({
          tag: el.tagName,
          className: el.className,
          right: rect.right
        });
      }
    });

    return { docWidth, viewWidth, overflowElements };
  });

  if (layoutMetrics.docWidth > layoutMetrics.viewWidth) {
    console.error(`❌ Layout broken! Document width (${layoutMetrics.docWidth}px) exceeds viewport width (${layoutMetrics.viewWidth}px).`);
    console.error('Elements causing overflow:');
    layoutMetrics.overflowElements.forEach(el => console.error(el));
    process.exit(1);
  } else {
    console.log('✅ Layout is perfectly optimized for mobile! No horizontal overflow detected.');
    console.log(`Document width: ${layoutMetrics.docWidth}px, Viewport width: ${layoutMetrics.viewWidth}px`);
  }

  await browser.close();
})();
