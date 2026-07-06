// Stop-motion capture of the hero GIF per landing/STORYBOARD.md.
// Drives the real app; every frame is a real interaction state.
import { chromium } from 'playwright';
import fs from 'node:fs';

const FRAMES = '/private/tmp/claude-501/-Users-sofiiashvets-src-html/c0f9cb84-995c-424b-826a-732105f4bd3c/scratchpad/frames';
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
page.on('download', (d) => d.saveAs(FRAMES + '/../' + d.suggestedFilename()).catch(() => {}));

await page.goto('http://localhost:8743/app/?sample=post');
await page.waitForSelector('.viewport iframe');
await page.waitForTimeout(3500); // import + fonts settle

const frame = page.frames().find((f) => f !== page.mainFrame());
await frame.evaluate(() => document.fonts.ready);
const ifb = await page.locator('.viewport iframe').boundingBox();
const ZOOM = 0.5;

let n = 0;
async function snap(times = 1) {
  for (let i = 0; i < times; i++) {
    await page.screenshot({ path: `${FRAMES}/f${String(n++).padStart(4, '0')}.png` });
  }
}
async function vis(sel, fx = 0.5, fy = 0.5) {
  const r = await frame.evaluate((s) => {
    const el = document.querySelector(s);
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);
  return { x: ifb.x + (r.x + r.w * fx) * ZOOM, y: ifb.y + (r.y + r.h * fy) * ZOOM };
}
function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
async function drag(from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const p = lerp(from, to, i / steps);
    await page.mouse.move(p.x, p.y);
    await snap();
  }
  await page.mouse.up();
  await snap(2);
}

// --- Shot 1: loaded state --------------------------------------------------
await snap(8);

// --- Shot 2: select headline, drag it up (snap guide fires near center) ----
const head = await vis('.hs-el.display');
await page.mouse.click(head.x, head.y);
await page.waitForTimeout(250);
await snap(5);
await drag(head, { x: head.x, y: head.y - 26 }, 12);
await snap(3);

// --- Shot 3: rotate the quote card, then settle back near zero -------------
const shell = await vis('.hs-el.shell');
await page.mouse.click(shell.x, shell.y);
await page.waitForTimeout(250);
await snap(4);
const rot = await vis('.moveable-rotation-control');
await drag(rot, { x: rot.x - 30, y: rot.y + 6 }, 8);   // tilt
const rot2 = await vis('.moveable-rotation-control');
await drag(rot2, { x: rot2.x + 28, y: rot2.y - 5 }, 6); // settle back (snaps < 3deg)
await snap(3);

// --- Shot 4: double-click the byline role, fix a word -----------------------
const role = await vis('.byline .role', 0.62, 0.5); // lands on "old" in "meets at the old bridge"
await page.mouse.dblclick(role.x, role.y);
await page.waitForTimeout(300);
await snap(4);
await page.keyboard.type('new', { delay: 40 });
await snap(6);
await page.mouse.click(head.x, head.y - 26); // blur the edit via reselect
await page.waitForTimeout(200);
await snap(2);

// --- Shot 5: delete the CTA pill --------------------------------------------
const cta = await vis('.hs-el.cta');
await page.mouse.click(cta.x, cta.y);
await page.waitForTimeout(250);
await snap(4);
await page.keyboard.press('Delete');
await page.waitForTimeout(250);
await snap(6);

// --- Shot 6: export PNG 2x ---------------------------------------------------
const scaleBtn = page.getByRole('button', { name: '2×', exact: true });
await scaleBtn.click();
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(140);
  await snap();
  const done = await page.locator('.export-list').textContent().catch(() => '');
  if (done && done.includes('Downloaded')) break;
}
await snap(10); // hold the finished state

await browser.close();
console.log('frames:', n);
