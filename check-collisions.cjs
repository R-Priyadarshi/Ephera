const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  // Set mobile viewport
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  
  console.log('Navigating to dashboard...');
  await page.goto('http://localhost:5174/');
  await new Promise(r => setTimeout(r, 2000)); // Wait for animations
  
  const report = await page.evaluate(() => {
    const issues = [];
    const allElements = Array.from(document.querySelectorAll('*'));
    
    // Check 1: Overflowing viewport
    const viewWidth = window.innerWidth;
    allElements.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > viewWidth && el.tagName !== 'BODY' && el.tagName !== 'HTML' && rect.width > 0 && rect.height > 0) {
        issues.push(`OVERFLOW: <${el.tagName.toLowerCase()} class="${el.className}"> exceeds viewport (right: ${rect.right} > ${viewWidth})`);
      }
      
      // Check 2: Overflowing parent
      if (el.parentElement) {
        const parentRect = el.parentElement.getBoundingClientRect();
        if ((rect.right > parentRect.right || rect.left < parentRect.left) && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && rect.width > 0 && rect.height > 0) {
           const overflowStyles = window.getComputedStyle(el.parentElement);
           if(overflowStyles.overflowX !== 'scroll' && overflowStyles.overflowX !== 'auto' && overflowStyles.overflowX !== 'hidden') {
               issues.push(`PARENT_OVERFLOW: <${el.tagName.toLowerCase()} class="${el.className}"> overflows parent <${el.parentElement.tagName.toLowerCase()} class="${el.parentElement.className}">`);
           }
        }
      }
    });

    // Check 3: Text overlapping or colliding elements
    for (let i = 0; i < allElements.length; i++) {
       const el1 = allElements[i];
       if(el1.tagName === 'BODY' || el1.tagName === 'HTML' || el1.children.length > 0) continue; // Only check leaf nodes (like text, buttons)
       const rect1 = el1.getBoundingClientRect();
       if(rect1.width === 0 || rect1.height === 0) continue;

       for (let j = i + 1; j < allElements.length; j++) {
           const el2 = allElements[j];
           if(el2.tagName === 'BODY' || el2.tagName === 'HTML' || el2.children.length > 0) continue;
           if(el1 === el2 || el1.contains(el2) || el2.contains(el1)) continue;

           const rect2 = el2.getBoundingClientRect();
           if(rect2.width === 0 || rect2.height === 0) continue;

           const style1 = window.getComputedStyle(el1);
           const style2 = window.getComputedStyle(el2);
           if (style1.pointerEvents === 'none' || style2.pointerEvents === 'none') continue;
           if (style1.opacity === '0' || style2.opacity === '0') continue;
           if (style1.visibility === 'hidden' || style2.visibility === 'hidden') continue;

           // Check collision
           if (rect1.left < rect2.right &&
               rect1.right > rect2.left &&
               rect1.top < rect2.bottom &&
               rect1.bottom > rect2.top) {
               
               // If they share a common parent that is absolute/relative maybe it's intentional, but flag it
               issues.push(`COLLISION: <${el1.tagName.toLowerCase()} class="${el1.className}"> collides with <${el2.tagName.toLowerCase()} class="${el2.className}">`);
           }
       }
    }
    
    return issues;
  });

  if (report.length > 0) {
    console.log(`Found ${report.length} potential layout issues:`);
    // Deduplicate
    const unique = [...new Set(report)];
    unique.forEach(i => console.log(i));
  } else {
    console.log('No overflows or collisions detected.');
  }

  await browser.close();
})();
