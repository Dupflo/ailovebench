import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from '../src/report/build.js';
import { loadRun } from '../src/report/data.js';
import { checkReportRules, failedRules, htmlText } from '../src/report/rules.js';

async function fixtureRun() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bm-report-'));
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({
    runId: '20261001-120000', startedAt: '2026-10-01T10:00:00Z', pricesUpdatedAt: '2026-10-01',
    machine: { os: 'macOS 26.3', arch: 'arm64', cpu: 'Apple M1', cores: 8, ramGb: 16, gpus: [{ name: 'Apple M1', vramGb: null }], node: '26.5.0', herdr: '0.8.0' },
    versions: { claude: '2.1.285', codex: '0.159.3', cursor: null, herdr: '0.8.0' },
    plan: { tasks: ['web-01'], models: ['claude-sonnet-5-5'], modes: ['bare'], effort: 'medium', tester: 'none', maxFixRounds: 3, sequential: false },
    waves: [],
  }));
  const job = path.join(dir, 'web-01__claude-sonnet-5-5__bare');
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, 'job.json'), JSON.stringify({
    schema: 2, id: 'web-01__claude-sonnet-5-5__bare', runId: '20261001-120000',
    task: { id: 'web-01', title: 'Landing page produit', category: 'Site web / frontend', promptHash: 'x' },
    agent: 'claude', model: 'claude-sonnet-5-5', modelsSeen: [], mode: 'bare', effort: 'medium', sessionId: 'none',
    workDir: path.join(job, 'work'), status: 'completed', phases: [], measure: null, qa: [], tester: null, bugs: [],
    verdict: 'works', split: null, pricesUpdatedAt: '2026-10-01', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:05:00Z',
  }));
  return dir;
}

describe('report rules', () => {
  it('the standard report meets every rule of docs/REPORT_RULES.md', async () => {
    const dir = await fixtureRun();
    const file = await buildReport(dir);
    const checks = checkReportRules(htmlText(await readFile(file, 'utf8')), await loadRun(dir));
    expect(failedRules(checks).map((c) => c.label)).toEqual([]);
    expect(checks.length).toBeGreaterThan(12);
  }, 60_000);

  it('in English, the report is fully English and still meets every rule', async () => {
    const { setLang } = await import('../src/i18n.js');
    setLang('en');
    try {
      const dir = await fixtureRun();
      const html = await readFile(await buildReport(dir), 'utf8');
      const text = htmlText(html);
      expect(html).toContain('<html lang="en">');
      expect(text).toContain('an indication, not a ranking');
      expect(text).toContain('This is not an invoice');
      expect(text).toContain('October 1, 2026');
      expect(text).toContain('Bench conditions');
      expect(text).not.toMatch(/une indication|Ce n'est pas une facture|Conditions du bench|Au cas par cas/);
      // Only run data (task title and category, from the French catalog) may stay French.
      const stray = text.replace(/Landing page produit|Site web \/ frontend/g, '').match(/\S*[éèêàùçôî]\S*/g) ?? [];
      expect(stray).toEqual([]);
      const checks = checkReportRules(text, await loadRun(dir));
      expect(failedRules(checks).map((c) => c.label)).toEqual([]);
      // English decimals and durations follow the same rules.
      expect(checkReportRules('took 755.7 s', await loadRun(dir), true).find((c) => c.id === 'durations')!.ok).toBe(false);
      expect(checkReportRules('cost 0.1191164 USD', await loadRun(dir), true).find((c) => c.id === 'amounts')!.ok).toBe(false);
    } finally {
      setLang('fr');
    }
  }, 60_000);
});

describe('date forms', async () => {
  const { dateForms } = await import('../src/report/rules.js');
  it('accepts every correct way to write the date', () => {
    expect(dateForms('2026-10-01T10:00:00Z')).toEqual(expect.arrayContaining(['1 octobre 2026', '1er octobre 2026', '1ᵉʳ octobre 2026', '01/10/2026', '2026-10-01']));
  });
});

describe('duration rule', async () => {
  const { checkReportRules } = await import('../src/report/rules.js');
  const run = { machine: null, versions: null, plan: null, jobs: [], startedAt: null, pricesUpdatedAt: null } as any;
  const ok = (t: string) => checkReportRules(t, run, true).find((c) => c.id === 'durations')!.ok;
  it('flags long durations left in seconds, and only those', () => {
    expect(ok('gpt-6-astra 2,17 $ / 755,7 s')).toBe(false);
    expect(ok('durée 119,9 s')).toBe(false);
    expect(ok('36,2 s · 12 min 36 s · 2026 · 59 s')).toBe(true);
  });
});
