import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import { ensureBrowser } from './browser.js';
import { tr } from '../i18n.js';

export interface LighthouseScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  report: string;
}

/**
 * Lighthouse with its default mobile profile, on the Chromium bundled with Playwright so every
 * machine runs the same browser. Scores are 0–100.
 */
export async function runLighthouse(url: string, outDir: string, prefix = 'lighthouse'): Promise<LighthouseScores> {
  await ensureBrowser();
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'html',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    if (!result) throw new Error(tr('Lighthouse n\'a rien renvoyé', 'Lighthouse returned nothing'));
    const report = path.join(outDir, `${prefix}.html`);
    await writeFile(report, Array.isArray(result.report) ? result.report[0]! : result.report);
    const score = (id: string) => {
      const s = result.lhr.categories[id]?.score;
      return typeof s === 'number' ? Math.round(s * 100) : null;
    };
    return {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo'),
      report,
    };
  } finally {
    await chrome.kill();
  }
}
