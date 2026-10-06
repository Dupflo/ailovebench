import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTasks } from '../src/catalog/load.js';
import { planWaves } from '../src/runner/bench.js';
import { quotaHistory, estimateNeed, quotaVerdict } from '../src/runner/quota-plan.js';

describe('catalog listing', () => {
  it('lists the built-in tasks with their budget', async () => {
    const tasks = await listTasks();
    expect(tasks.map((t) => t.id)).toEqual(expect.arrayContaining(['web-01', '3d-01', 'fix-01']));
    expect(tasks.find((t) => t.id === 'web-01')).toMatchObject({ title: 'Landing page produit', budgetMinutes: 15 });
  });
});

describe('waves', () => {
  it('runs one project at a time, all models together, bare then harness by default', () => {
    const waves = planWaves({ tasks: ['web-01', '3d-01'], models: ['claude-sonnet-5-5', 'gpt-6-astra'], modes: ['bare', 'harness'] });
    expect(waves).toEqual([
      { task: 'web-01', jobs: [{ model: 'claude-sonnet-5-5', mode: 'bare' }, { model: 'gpt-6-astra', mode: 'bare' }] },
      { task: 'web-01', jobs: [{ model: 'claude-sonnet-5-5', mode: 'harness' }, { model: 'gpt-6-astra', mode: 'harness' }] },
      { task: '3d-01', jobs: [{ model: 'claude-sonnet-5-5', mode: 'bare' }, { model: 'gpt-6-astra', mode: 'bare' }] },
      { task: '3d-01', jobs: [{ model: 'claude-sonnet-5-5', mode: 'harness' }, { model: 'gpt-6-astra', mode: 'harness' }] },
    ]);
  });

  it('can merge the two modes into one wave', () => {
    const waves = planWaves({ tasks: ['web-01'], models: ['m1'], modes: ['bare', 'harness'], modesTogether: true });
    expect(waves).toEqual([{ task: 'web-01', jobs: [{ model: 'm1', mode: 'bare' }, { model: 'm1', mode: 'harness' }] }]);
  });

  it('runs one job per wave in sequential mode', () => {
    const waves = planWaves({ tasks: ['web-01'], models: ['m1', 'm2'], modes: ['bare'], sequential: true });
    expect(waves.map((w) => w.jobs.length)).toEqual([1, 1]);
  });
});

describe('quota planning', () => {
  async function runsWith(jobs: Array<{ task: string; model: string; agent: string; phases: Array<[number, number]>; tester?: { agent: string; phases: Array<[number, number]> } }>) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bm-hist-'));
    for (const [i, j] of jobs.entries()) {
      const dir = path.join(root, `run${i}`, `${j.task}__${j.model}__bare`);
      await mkdir(dir, { recursive: true });
      const phase = ([a, b]: [number, number]) => ({ quotaBefore: { window5hPct: a, weekPct: 0 }, quotaAfter: { window5hPct: b, weekPct: 0 } });
      await writeFile(path.join(dir, 'job.json'), JSON.stringify({
        task: { id: j.task }, model: j.model, agent: j.agent, phases: j.phases.map(phase),
        tester: j.tester ? { agent: j.tester.agent, phases: j.tester.phases.map(phase) } : null,
      }));
    }
    return root;
  }

  it('learns the 5-hour share used per (task, model) and per tester agent from past jobs', async () => {
    const root = await runsWith([
      { task: 'web-01', model: 'gpt-6-astra', agent: 'codex', phases: [[0, 14]] },
      { task: 'web-01', model: 'gpt-6-astra', agent: 'codex', phases: [[20, 30], [30, 32]] },
      { task: 'web-01', model: 'claude-sonnet-5-5', agent: 'claude', phases: [[4, 4]], tester: { agent: 'codex', phases: [[14, 20]] } },
    ]);
    const h = await quotaHistory(root);
    expect(h.byTaskModel['web-01|gpt-6-astra']).toEqual({ avg: 13, samples: 2 });
    expect(h.byTaskModel['web-01|claude-sonnet-5-5']).toEqual({ avg: 0, samples: 1 });
    expect(h.testerByAgent['codex']).toEqual({ avg: 6, samples: 1 });
  });

  it('estimates the need per provider, with tester share, and says when it is unknown', async () => {
    const root = await runsWith([{ task: 'web-01', model: 'gpt-6-astra', agent: 'codex', phases: [[0, 14]] }]);
    const h = await quotaHistory(root);
    const need = estimateNeed(h, [
      { task: 'web-01', model: 'gpt-6-astra', agent: 'codex', testerAgent: 'claude' },
      { task: '3d-01', model: 'gpt-6-astra', agent: 'codex', testerAgent: 'claude' },
    ]);
    expect(need.codex).toEqual({ pct: 14, known: 1, unknown: 1 });
    expect(need.claude).toEqual({ pct: 0, known: 0, unknown: 2 });
  });

  it('turns need and remaining quota into a verdict', () => {
    expect(quotaVerdict({ pct: 30, known: 3, unknown: 0 }, 80)).toBe('ok');
    expect(quotaVerdict({ pct: 70, known: 3, unknown: 0 }, 80)).toBe('tight');
    expect(quotaVerdict({ pct: 95, known: 3, unknown: 0 }, 80)).toBe('ko');
    expect(quotaVerdict({ pct: 0, known: 0, unknown: 3 }, 80)).toBe('unknown');
    expect(quotaVerdict({ pct: 10, known: 1, unknown: 0 }, null)).toBe('unknown');
  });
});

describe('recent runs', () => {
  it('lists runs newest first with what they contain', async () => {
    const { listRecentRuns } = await import('../src/report/data.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'bm-recent-'));
    const job = (task: string, model: string, verdict: string) => ({ task: { id: task, title: task, category: 'c' }, model, mode: 'bare', verdict, startedAt: '2026-10-01T10:00:00Z' });
    for (const [run, jobs] of [
      ['20261001-100000', [job('web-01', 'claude-sonnet-5-5', 'works')]],
      ['20261001-120000', [job('web-01', 'gpt-6-astra', 'works'), job('3d-01', 'gpt-6-astra', 'works_with_bugs')]],
    ] as const) {
      for (const j of jobs) {
        const dir = path.join(root, run, `${j.task.id}__${j.model}__bare`);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'job.json'), JSON.stringify(j));
      }
    }
    await mkdir(path.join(root, '20261001-130000'), { recursive: true }); // empty run: ignored
    const runs = await listRecentRuns(root);
    expect(runs.map((r) => r.runId)).toEqual(['20261001-120000', '20261001-100000']);
    expect(runs[0]).toMatchObject({ jobs: 2, tasks: ['3d-01', 'web-01'], models: ['gpt-6-astra'], works: 1 });
  });
});

describe('deleting a run', async () => {
  const { deleteRun } = await import('../src/report/data.js');
  it('deletes a run folder and refuses anything that is not a run id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bm-del-'));
    await mkdir(path.join(root, '20261001-120000', 'job'), { recursive: true });
    await deleteRun(root, '20261001-120000');
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).toEqual([]);
    await expect(deleteRun(root, '../..')).rejects.toThrow(/invalide/);
    await expect(deleteRun(root, '*')).rejects.toThrow(/invalide/);
  });
});
