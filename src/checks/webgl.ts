import path from 'node:path';
import { PNG } from 'pngjs';
import { withBrowser } from './browser.js';

export interface WebglInspection {
  hasCanvas: boolean;
  webgl: boolean;
  /** Share of pixels that differ from the dominant color (0–1): ~0 means a blank canvas. */
  coverage: number;
  /** Share of pixels that changed between two frames 1 s apart (0–1): > 0 means animated. */
  motion: number;
  /** Share of pixels changed over ~0.8 s with no interaction (0–1): the animation alone. */
  baseline: number;
  /** Share of pixels changed over the same time while dragging (0–1). */
  drag: number;
  /** Covered area after a wheel zoom-in divided by the area before (1 = no zoom). */
  zoomRatio: number;
  fps: number;
  screenshots: string[];
}

function decode(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/** Fraction of pixels whose color is far from the most frequent one. */
export function coverage(png: PNG): number {
  const counts = new Map<number, number>();
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const key = ((png.data[o]! >> 4) << 8) | ((png.data[o + 1]! >> 4) << 4) | (png.data[o + 2]! >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dominant = Math.max(...counts.values());
  return n ? 1 - dominant / n : 0;
}

/** Fraction of pixels that differ noticeably between two same-size images. */
export function difference(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = a.width * a.height;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o]! - b.data[o]!) + Math.abs(a.data[o + 1]! - b.data[o + 1]!) + Math.abs(a.data[o + 2]! - b.data[o + 2]!);
    if (d > 30) changed++;
  }
  return n ? changed / n : 0;
}

/** Finds the largest canvas, checks it renders, animates, reacts to a drag, and measures fps. */
export async function inspectWebgl(url: string, outDir: string): Promise<WebglInspection> {
  return withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForTimeout(2500);

    const info = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')];
      if (!canvases.length) return null;
      const c = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]!;
      c.setAttribute('data-bm-target', '1');
      // Three.js and most engines create their context before we look; asking again returns it.
      const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) !== null;
      return { gl };
    });
    if (!info) return { hasCanvas: false, webgl: false, coverage: 0, motion: 0, baseline: 0, drag: 0, zoomRatio: 1, fps: 0, screenshots: [] };

    const canvas = page.locator('canvas[data-bm-target="1"]');
    const shots = [path.join(outDir, 'webgl-a.png'), path.join(outDir, 'webgl-b.png'), path.join(outDir, 'webgl-drag.png')];
    const a = decode(await canvas.screenshot({ path: shots[0] }));
    await page.waitForTimeout(1000);
    const b = decode(await canvas.screenshot({ path: shots[1] }));

    const fps = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            frames++;
            if (performance.now() - start < 2000) requestAnimationFrame(tick);
            else resolve((frames * 1000) / (performance.now() - start));
          };
          requestAnimationFrame(tick);
        }),
    );

    // Same time window with and without interaction, so the animation's own motion cancels out.
    const WINDOW = 800;
    const base0 = decode(await canvas.screenshot());
    await page.waitForTimeout(WINDOW);
    const base1 = decode(await canvas.screenshot());

    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Drag over the same window: compared with the baseline, the animation's own motion cancels out.
    const t0 = Date.now();
    const beforeDrag = decode(await canvas.screenshot());
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width / 5, cy - box.height / 5, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(Math.max(0, WINDOW - (Date.now() - t0)));
    const afterDrag = decode(await canvas.screenshot({ path: shots[2] }));

    // Wheel zoom-in: objects get bigger, so the covered area changes regardless of the animation.
    const beforeZoom = coverage(decode(await canvas.screenshot()));
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(400);
    const afterZoom = coverage(decode(await canvas.screenshot()));

    return {
      hasCanvas: true,
      webgl: info.gl,
      coverage: coverage(a),
      motion: difference(a, b),
      baseline: difference(base0, base1),
      drag: difference(beforeDrag, afterDrag),
      zoomRatio: beforeZoom > 0 ? afterZoom / beforeZoom : 1,
      fps: Math.round(fps),
      screenshots: shots,
    };
  });
}
