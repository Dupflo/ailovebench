import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBrowser } from '../checks/browser.js';

/** Prints the slides to PDF, one 1280×720 page per slide (print CSS of the report). */
export async function reportToPdf(htmlFile: string): Promise<string> {
  const out = path.join(path.dirname(htmlFile), 'ailovebench-report.pdf');
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: out, width: '1280px', height: '720px', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  });
  return out;
}
