import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { cp, mkdtemp, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bugsFromChecks, updateBugs, fixPrompt, verdictOf, costSplit, type Bug } from '../src/qa/bugs.js';
import { runBugScript } from '../src/qa/repro.js';
import { parseFailingTests, runHiddenTests } from '../src/checks/hidden-tests.js';
import { serveStatic, type StaticServer } from '../src/checks/serve.js';
import { runBuild } from '../src/checks/build.js';
import { withBrowser } from '../src/checks/browser.js';
import type { ChecksRun } from '../src/checks/run.js';
import type { CheckResult } from '../src/checks/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const qa = (round: number, results: CheckResult[]): ChecksRun => ({
  round, startedAt: '', endedAt: '', results,
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status !== 'pass').length,
});

describe('bugs from checks', () => {
  it('turns failed checks into confirmed bugs, ignoring passes, skips and tool errors', () => {
    const bugs = bugsFromChecks(qa(0, [
      { id: 'build', label: 'Build', status: 'pass' },
      { id: 'console', label: 'Console sans erreur', status: 'fail', detail: 'TypeError: x is undefined' },
      { id: 'lighthouse.seo', label: 'Lighthouse seo', status: 'error', detail: 'timeout' },
      { id: 'webgl.fps', label: 'Fluidité', status: 'skip' },
    ]));
    expect(bugs).toEqual([
      expect.objectContaining({ id: 'C-console', source: 'check', scope: 'spec', checkId: 'console', status: 'confirmed', foundInRound: 0, actual: 'TypeError: x is undefined' }),
    ]);
  });
});

describe('bug updates after a fix round', () => {
  const initial: Bug[] = [
    { id: 'C-console', source: 'check', scope: 'spec', checkId: 'console', title: 'Console sans erreur', status: 'confirmed', foundInRound: 0 },
    { id: 'T-1', source: 'tester', scope: 'spec', title: 'Le menu ne s’ouvre pas', script: 'bugs/T-1.mjs', status: 'confirmed', foundInRound: 0 },
    { id: 'T-2', source: 'tester', scope: 'spec', title: 'Bug douteux', script: 'bugs/T-2.mjs', status: 'unconfirmed', foundInRound: 0 },
  ];
  const round0 = qa(0, [
    { id: 'console', label: 'Console sans erreur', status: 'fail' },
    { id: 'responsive', label: 'Pas de défilement horizontal', status: 'pass' },
  ]);

  it('marks fixed and remaining bugs, and adds regressions on checks that used to pass', () => {
    const round1 = qa(1, [
      { id: 'console', label: 'Console sans erreur', status: 'pass' },
      { id: 'responsive', label: 'Pas de défilement horizontal', status: 'fail', detail: '375 px → 520 px' },
    ]);
    const out = updateBugs(initial, round0, round1, { 'T-1': true }, 1);
    expect(out.find((b) => b.id === 'C-console')).toMatchObject({ status: 'fixed', fixedInRound: 1 });
    expect(out.find((b) => b.id === 'T-1')).toMatchObject({ status: 'remaining' });
    expect(out.find((b) => b.id === 'T-2')).toMatchObject({ status: 'unconfirmed' });
    expect(out.find((b) => b.id === 'C-responsive')).toMatchObject({ status: 'regression', foundInRound: 1, actual: '375 px → 520 px' });
  });

  it('marks a tester bug inconclusive when its script crashes instead of asserting', () => {
    const out = updateBugs(initial, round0, round0, { 'T-1': null }, 1);
    expect(out.find((b) => b.id === 'T-1')).toMatchObject({ status: 'inconclusive' });
  });

  it('marks a tester bug fixed when its script stops reproducing it', () => {
    const out = updateBugs(initial, round0, round0, { 'T-1': false }, 1);
    expect(out.find((b) => b.id === 'T-1')).toMatchObject({ status: 'fixed', fixedInRound: 1 });
  });
});

describe('fix prompt', () => {
  it('lists open bugs with what was expected and observed, and never leaks the tester scripts', () => {
    const prompt = fixPrompt([
      { id: 'C-console', source: 'check', scope: 'spec', checkId: 'console', title: 'Console sans erreur', actual: 'TypeError: x', status: 'confirmed', foundInRound: 0 },
      { id: 'T-1', source: 'tester', scope: 'spec', title: 'Le menu ne s’ouvre pas', steps: ['Ouvrir la page en 375 px', 'Cliquer sur ☰'], expected: 'Le menu s’ouvre', actual: 'Rien ne se passe', script: 'bugs/T-1.mjs', status: 'confirmed', foundInRound: 0 },
    ], 1);
    expect(prompt).toContain('Console sans erreur');
    expect(prompt).toContain('TypeError: x');
    expect(prompt).toContain('Cliquer sur ☰');
    expect(prompt).toContain('Le menu s’ouvre');
    expect(prompt).not.toContain('T-1.mjs');
    expect(prompt).toMatch(/TERMINÉ/);
  });
});

describe('verdict and cost split', () => {
  it('derives the verdict from the final state', () => {
    expect(verdictOf('completed', [], true)).toBe('works');
    expect(verdictOf('completed', [{ status: 'remaining' } as Bug], true)).toBe('works_with_bugs');
    expect(verdictOf('completed', [{ status: 'fixed' } as Bug, { status: 'unconfirmed' } as Bug], true)).toBe('works');
    expect(verdictOf('completed', [], false)).toBe('broken');
    expect(verdictOf('timeout', [], true)).toBe('abandoned');
  });

  it('splits cost and time between the initial build and the rework', () => {
    const split = costSplit(
      [
        { phase: 'build', requests: 3, usage: {} as any, cost: { value: 1.2, kind: 'estimated' } },
        { phase: 'fix-1', requests: 2, usage: {} as any, cost: { value: 0.45, kind: 'estimated' } },
        { phase: 'fix-2', requests: 1, usage: {} as any, cost: { value: 0.2, kind: 'estimated' } },
      ],
      [
        { name: 'build', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:09:00Z' },
        { name: 'fix-1', startedAt: '2026-10-01T10:12:00Z', endedAt: '2026-10-01T10:16:00Z' },
        { name: 'fix-2', startedAt: '2026-10-01T10:20:00Z', endedAt: '2026-10-01T10:23:00Z' },
      ] as any,
    );
    expect(split.initial).toEqual({ costUsd: 1.2, timeMs: 9 * 60_000 });
    expect(split.rework.costUsd).toBeCloseTo(0.65, 8);
    expect(split.rework.timeMs).toBe(7 * 60_000);
    expect(split.total.costUsd).toBeCloseTo(1.85, 8);
    expect(split.reworkShare).toBeCloseTo(0.65 / 1.2, 8);
  });
});

describe('bug scripts', () => {
  let server: StaticServer;
  let dir: string;
  beforeAll(async () => {
    const site = await mkdtemp(path.join(os.tmpdir(), 'bm-repro-'));
    await cp(path.join(here, 'fixtures/sites/good'), site, { recursive: true });
    await runBuild(site, { install: 'npm install', build: 'npm run build', static_dir: 'dist', entry: 'index.html' });
    server = await serveStatic(path.join(site, 'dist'));
    dir = await mkdtemp(path.join(os.tmpdir(), 'bm-bugs-'));
    await writeFile(path.join(dir, 'absent.mjs'),
      `export default async ({ page, assert }) => { assert.equal(await page.locator('h1').innerText(), 'Lumio'); };`);
    await writeFile(path.join(dir, 'present.mjs'),
      `export default async ({ page, assert }) => { assert.equal(await page.locator('h2').count(), 5, 'il devrait y avoir 5 sections'); };`);
    await writeFile(path.join(dir, 'broken.mjs'),
      `export default async ({ page }) => { await page.locator('a', { hasText: 'Introuvable' }).click({ timeout: 500 }); };`);
  }, 120_000);
  afterAll(() => server?.close());

  it('reports a bug as present when the script fails, absent when it passes', async () => {
    await withBrowser(async (browser) => {
      expect(await runBugScript(browser, path.join(dir, 'absent.mjs'), server.url)).toEqual({ present: false });
      const present = await runBugScript(browser, path.join(dir, 'present.mjs'), server.url);
      expect(present.present).toBe(true);
      expect(present.error).toContain('5 sections');
      const broken = await runBugScript(browser, path.join(dir, 'broken.mjs'), server.url);
      expect(broken.present).toBeNull();
    });
  }, 60_000);
});

describe('hidden tests', () => {
  it('names the failing tests as a client would, without paths or stacks', () => {
    const out = [
      'ok 1 - a',
      'not ok 2 - MOINS5 : jamais négatif',
      '  ---',
      "  location: '/tmp/x/hidden-tests/cart.hidden.test.js:20:1'",
      '  error: |-',
      '    Expected values to be strictly equal:',
      '  expected: 0',
      '  actual: -200',
      '  stack: |-',
      '    TestContext.<anonymous> (file:///tmp/x/hidden-tests/cart.hidden.test.js:20:46)',
      '  ...',
      'not ok 3 - code inconnu : erreur',
      '  ---',
      "  error: 'Missing expected exception (validation function).'",
      '  ...',
      '# pass 1',
      '# fail 2',
    ].join('\n');
    const failing = parseFailingTests(out);
    expect(failing).toEqual([
      { name: 'MOINS5 : jamais négatif', message: 'attendu 0, obtenu -200' },
      { name: 'code inconnu : erreur', message: "'Missing expected exception (validation function).'" },
    ]);
    expect(JSON.stringify(failing)).not.toContain('hidden-tests');
  });

  it('removes the hidden tests from the work folder once they have run', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'bm-fix-'));
    await cp(path.join(here, '../catalog/fix-01/starter'), work, { recursive: true });
    const r = await runHiddenTests(work, path.join(here, '../catalog/fix-01/hidden'), 'node --test --test-reporter=tap hidden-tests/*.test.js');
    expect(r.passed + r.failed).toBe(17);
    expect(await readdir(work)).not.toContain('hidden-tests');
  });
});

describe('cost split with unknown prices', () => {
  it('never turns an unpriced build into 0 $', () => {
    const split = costSplit(
      [{ phase: 'build', requests: 3, usage: {} as any, cost: { value: null, kind: 'unpriced' } }],
      [{ name: 'build', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:05:00Z' }] as any,
    );
    expect(split.initial.costUsd).toBeNull();
    expect(split.rework.costUsd).toBe(0);
    expect(split.total.costUsd).toBeNull();
  });
});

describe('outside-spec remarks', () => {
  it('never sends a remark back to the agent nor counts it in the verdict', () => {
    const remark: Bug = { id: 'T-B1', source: 'tester', scope: 'outside', title: 'Liens vers #', status: 'remark', foundInRound: 0 };
    expect(verdictOf('completed', [remark], true)).toBe('works');
    expect(updateBugs([remark], qa(0, []), qa(1, []), {}, 1)).toEqual([remark]);
  });
});
