import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';

/**
 * A bug script asserts the EXPECTED behaviour: it throws while the bug is present.
 *
 *   export default async ({ page, url, assert }) => {
 *     await page.getByRole('button', { name: 'Menu' }).click();
 *     assert.ok(await page.locator('nav').isVisible(), 'le menu devrait s'ouvrir');
 *   };
 */
export interface BugScriptContext {
  page: Page;
  url: string;
  assert: typeof assert;
}

/**
 * `present: true` only when an assertion fails: that is the proof of the bug. A script that crashes
 * (element not found, timeout…) proves nothing — the page may simply have changed — so it is
 * `present: null`, inconclusive.
 */
export interface ReproResult {
  present: boolean | null;
  error?: string;
}

const isAssertion = (err: unknown) =>
  err instanceof Error && (err.name === 'AssertionError' || (err as { code?: string }).code === 'ERR_ASSERTION');

/** Runs one bug script on a fresh page. Each call re-imports the file so edits are picked up. */
export async function runBugScript(browser: Browser, file: string, url: string, timeoutMs = 30_000): Promise<ReproResult> {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await Promise.race([
      mod.default({ page, url, assert } satisfies BugScriptContext),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`script trop long (> ${timeoutMs / 1000} s)`)), timeoutMs)),
    ]);
    return { present: false };
  } catch (err) {
    return { present: isAssertion(err) ? true : null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await page.close();
  }
}

/** A bug is confirmed only if its assertion fails every time (twice by default). */
export async function confirmBug(browser: Browser, file: string, url: string, times = 2): Promise<ReproResult> {
  let last: ReproResult = { present: false };
  for (let i = 0; i < times; i++) {
    last = await runBugScript(browser, file, url);
    if (last.present !== true) return last;
  }
  return last;
}
