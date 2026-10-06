// Scenarios of task 3d-01, replayed identically on every agent's output.
import { PNG } from 'pngjs';
export default async function scenarios({ page, check }) {
  const viewport = page.viewportSize();
  const box = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  check('fullscreen', 'La scène occupe toute la fenêtre', !!box && box.w >= viewport.width * 0.95 && box.h >= viewport.height * 0.9,
    box ? `${Math.round(box.w)}×${Math.round(box.h)} pour ${viewport.width}×${viewport.height}` : 'aucun canvas');

  // Pause button: a visible button whose text or label reads like pause / play.
  const pause = page.locator('button, [role="button"]').filter({ hasText: /pause|lecture|play|⏸|▶/i })
    .or(page.locator('button[aria-label*="ause" i], button[aria-label*="lecture" i], button[aria-label*="play" i]')).first();
  const hasPause = (await pause.count()) > 0 && (await pause.isVisible());
  check('pause_button', 'Bouton pause / lecture visible', hasPause);
  if (!hasPause) return;

  const canvas = page.locator('canvas').first();
  await pause.click();
  await page.waitForTimeout(500);
  const a = await canvas.screenshot();
  await page.waitForTimeout(1000);
  const b = await canvas.screenshot();
  const changed = changedShare(a, b);
  check('pause_works', 'La pause fige l\'animation', changed < 0.005,
    `${(changed * 100).toFixed(2)} % de pixels changés en 1 s après la pause`);
  await pause.click();
}

// Share of pixels that clearly change between two PNG captures of the same size.
function changedShare(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 30) changed++;
  }
  return changed / (a.width * a.height);
}
