import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, type StaticServer } from '../src/checks/serve.js';
import { runBuild } from '../src/checks/build.js';
import { inspectSite } from '../src/checks/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const deliverable = { install: 'npm install', build: 'npm run build', static_dir: 'dist', entry: 'index.html' };

async function copySite(name: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `bm-site-${name}-`));
  await cp(path.join(here, 'fixtures/sites', name), dir, { recursive: true });
  return dir;
}

describe('build check', () => {
  it('passes when install and build succeed and the entry exists', async () => {
    const work = await copySite('good');
    const r = await runBuild(work, deliverable);
    expect(r.status).toBe('pass');
    expect((await stat(path.join(work, 'dist/index.html'))).isFile()).toBe(true);
  }, 120_000);

  it('fails when the build does not produce the entry', async () => {
    const work = await copySite('good');
    const r = await runBuild(work, { ...deliverable, entry: 'missing.html' });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/missing\.html/);
  }, 120_000);
});

describe('browser checks', () => {
  let good: StaticServer;
  let bad: StaticServer;
  let out: string;

  beforeAll(async () => {
    const g = await copySite('good');
    const b = await copySite('bad');
    await runBuild(g, deliverable);
    await runBuild(b, deliverable);
    good = await serveStatic(path.join(g, 'dist'));
    bad = await serveStatic(path.join(b, 'dist'));
    out = await mkdtemp(path.join(os.tmpdir(), 'bm-qa-'));
  }, 120_000);

  afterAll(async () => {
    await good?.close();
    await bad?.close();
  });

  it('reports a clean page as clean', async () => {
    const r = await inspectSite(good.url, { widths: [375, 1440], screenshotsDir: out });
    expect(r.consoleErrors).toEqual([]);
    expect(r.pageErrors).toEqual([]);
    expect(r.externalRequests).toEqual([]);
    expect(r.overflow).toEqual([]);
    for (const shot of r.screenshots) expect((await stat(shot)).size).toBeGreaterThan(1000);
  }, 60_000);

  it('catches console errors, uncaught exceptions, external requests and horizontal overflow', async () => {
    const r = await inspectSite(bad.url, { widths: [375, 1440], screenshotsDir: out });
    expect(r.consoleErrors.join(' ')).toContain('boom');
    expect(r.pageErrors.join(' ')).toContain('undefinedFunction');
    expect(r.externalRequests.join(' ')).toContain('example.invalid');
    expect(r.overflow.map((o) => o.width)).toEqual([375, 1440]);
  }, 60_000);
});

describe('pixel analysis', async () => {
  const { PNG } = await import('pngjs');
  const { coverage, difference } = await import('../src/checks/webgl.js');
  const img = (fill: (x: number, y: number) => [number, number, number]) => {
    const png = new PNG({ width: 20, height: 20 });
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++) {
        const [r, g, b] = fill(x, y);
        const o = (y * 20 + x) * 4;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
      }
    return png;
  };

  it('sees a blank canvas as blank and a drawn one as covered', () => {
    expect(coverage(img(() => [0, 0, 0]))).toBe(0);
    expect(coverage(img((x) => (x < 5 ? [255, 200, 0] : [0, 0, 0])))).toBeCloseTo(0.25, 5);
  });

  it('measures the share of changed pixels between two frames', () => {
    const a = img(() => [0, 0, 0]);
    const b = img((x, y) => (x < 10 && y < 10 ? [255, 255, 255] : [0, 0, 0]));
    expect(difference(a, a)).toBe(0);
    expect(difference(a, b)).toBeCloseTo(0.25, 5);
  });
});

describe('node test output', async () => {
  const { parseNodeTestOutput } = await import('../src/checks/hidden-tests.js');
  it('reads TAP and spec reporter totals', () => {
    expect(parseNodeTestOutput('ok 1 - a\n# tests 3\n# pass 2\n# fail 1\n')).toEqual({ passed: 2, failed: 1 });
    expect(parseNodeTestOutput('✔ a\nℹ tests 3\nℹ pass 3\nℹ fail 0\n')).toEqual({ passed: 3, failed: 0 });
    expect(parseNodeTestOutput('nothing')).toBeNull();
  });
});
