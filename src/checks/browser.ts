import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { tr } from '../i18n.js';

export interface SiteInspection {
  consoleErrors: string[];
  pageErrors: string[];
  /** Requests to any host other than the local server. */
  externalRequests: string[];
  failedRequests: string[];
  /** Widths where the page scrolls horizontally. */
  overflow: Array<{ width: number; scrollWidth: number }>;
  screenshots: string[];
}

export interface InspectOptions {
  widths: number[];
  screenshotsDir: string;
  /** Screenshot file prefix. */
  prefix?: string;
}

// Chromium's own GPU chatter, not the page's.
const IGNORED_CONSOLE = /GL Driver Message|GPU stall due to ReadPixels/;

let browserReady: Promise<void> | null = null;

/**
 * The QA browser (Playwright's Chromium) is downloaded on first use, so installing the package is
 * a single `npm i -g ailovebench` (or `npx ailovebench`).
 */
export function ensureBrowser(): Promise<void> {
  browserReady ??= (async () => {
    if (existsSync(chromium.executablePath())) return;
    process.stderr.write(tr('Premier lancement : installation du navigateur de test (Chromium, une seule fois)…\n', 'First run: installing the test browser (Chromium, once)…\n'));
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright')), 'cli.js');
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [cli, 'install', 'chromium'], { maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve())),
    );
  })();
  return browserReady;
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  await ensureBrowser();
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Loads the page at each width; collects errors, outside requests, overflow, and full-page screenshots. */
export async function inspectSite(url: string, o: InspectOptions): Promise<SiteInspection> {
  const origin = new URL(url).origin;
  const r: SiteInspection = { consoleErrors: [], pageErrors: [], externalRequests: [], failedRequests: [], overflow: [], screenshots: [] };
  const push = (list: string[], v: string) => void (list.includes(v) || list.push(v));

  await withBrowser(async (browser) => {
    for (const width of o.widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.on('console', (m) => {
        if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) push(r.consoleErrors, m.text());
      });
      page.on('pageerror', (e) => push(r.pageErrors, e.message));
      page.on('request', (req) => {
        const u = req.url();
        if (/^https?:/.test(u) && new URL(u).origin !== origin) push(r.externalRequests, u);
      });
      page.on('requestfailed', (req) => {
        if (new URL(req.url()).origin === origin) push(r.failedRequests, req.url());
      });

      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(1000);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (scrollWidth > width + 1) r.overflow.push({ width, scrollWidth });
      const shot = path.join(o.screenshotsDir, `${o.prefix ?? 'page'}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      r.screenshots.push(shot);
      await page.close();
    }
  });
  return r;
}
