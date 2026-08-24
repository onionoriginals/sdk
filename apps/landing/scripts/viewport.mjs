// Narrow-viewport overflow check.
//
// The demo card used to render 457px of content inside its own 325px shell at
// 375px, and .demo-shell's overflow:hidden sliced every line in it; the footer
// pushed the whole page 44px sideways at 320px. Both were invisible to every
// other gate we run, because nothing else looks at the page below 1440px.
//
// Passes when, at each width, the document does not scroll horizontally and
// no element has content clipped out of view. Two things are explicitly NOT
// failures, because neither hides anything:
//   - a box with overflow-x:auto (the event-log tab strip) — it scrolls, and
//     every tab stays reachable;
//   - a pointer-events:none absolutely-positioned decoration bled past the
//     edge on purpose and clipped by its own container (the hero's ring art);
//   - a form field, which always scrolls its own value when the text is
//     longer than the box. That is the control working, not the page breaking,
//     and gating on it would fail the moment someone typed a long title.
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const WIDTHS = [320, 375, 414];

const AUDIT = () => {
  const name = (el) =>
    el.tagName.toLowerCase() +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '');
  const decorative = (el) => {
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none' && (cs.position === 'absolute' || cs.position === 'fixed')) return true;
    const p = el.parentElement && getComputedStyle(el.parentElement);
    return !!p && p.pointerEvents === 'none' && (p.position === 'absolute' || p.position === 'fixed');
  };

  const doc = document.documentElement;
  const clipped = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const overflows = el.clientWidth > 0 && el.scrollWidth - el.clientWidth > 1;
    const pastViewport = rect.right - window.innerWidth > 1;
    if (!overflows && !pastViewport) continue;
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue; // scrolls, not hidden
    if (decorative(el)) continue;
    if (/^(input|textarea|select)$/.test(el.tagName.toLowerCase())) continue;
    // A box that clips its own overflow is fine when what it hides is only
    // decoration — that is what the hero does with its ring art.
    if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
      const out = [...el.querySelectorAll('*')].filter((d) => {
        const dr = d.getBoundingClientRect();
        return dr.width > 0 && dr.right - rect.right > 1;
      });
      if (out.length > 0 && out.every(decorative)) continue;
    }
    clipped.push({
      sel: name(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowPx: overflows ? el.scrollWidth - el.clientWidth : 0,
      pastViewport: pastViewport ? Math.round((rect.right - window.innerWidth) * 10) / 10 : 0,
    });
  }
  return { pageOverflow: doc.scrollWidth - doc.clientWidth, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, clipped };
};

const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
let failures = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.demo-shell', { state: 'attached' });
  await page.waitForTimeout(400);
  const r = await page.evaluate(AUDIT);

  if (r.pageOverflow > 1) {
    failures++;
    console.error(`[viewport] FAIL ${width}px: page scrolls horizontally — document ${r.scrollWidth} vs viewport ${r.clientWidth} (+${r.pageOverflow}px)`);
  }
  if (r.clipped.length) {
    failures++;
    console.error(`[viewport] FAIL ${width}px: ${r.clipped.length} element(s) with content clipped out of view:`);
    for (const c of r.clipped) {
      const why = [];
      if (c.overflowPx) why.push(`content ${c.scrollWidth} in ${c.clientWidth} box (+${c.overflowPx}px)`);
      if (c.pastViewport) why.push(`${c.pastViewport}px past the viewport`);
      console.error(`             ${c.sel}: ${why.join('; ')}`);
    }
  }
  if (r.pageOverflow <= 1 && !r.clipped.length) {
    console.log(`[viewport] ok ${width}px: no horizontal page scroll, nothing clipped`);
  }
  await page.close();
}

await browser.close();
if (failures) {
  console.error('[viewport] FAILED');
  process.exit(1);
}
console.log('[viewport] PASS');
