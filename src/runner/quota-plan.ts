import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

interface PhaseQuota {
  quotaBefore: { window5hPct: number | null } | null;
  quotaAfter: { window5hPct: number | null } | null;
}

export interface Avg {
  avg: number;
  samples: number;
}

/** What past jobs consumed of the 5-hour window, learnt from `job.json` files. */
export interface QuotaHistory {
  byTaskModel: Record<string, Avg>;
  testerByAgent: Record<string, Avg>;
  /** API-equivalent cost (USD) to the final product, per task|model. */
  costByTaskModel: Record<string, Avg>;
}

/** Share of the 5-hour window used by a list of phases; null if no phase was read on both sides. */
function used(phases: PhaseQuota[] = []): number | null {
  let total = 0;
  let any = false;
  for (const p of phases) {
    const a = p.quotaBefore?.window5hPct;
    const b = p.quotaAfter?.window5hPct;
    // A drop means the window reset during the phase: the reading is unusable.
    if (typeof a === 'number' && typeof b === 'number' && b >= a) {
      total += b - a;
      any = true;
    }
  }
  return any ? total : null;
}

function push(map: Record<string, { sum: number; n: number }>, key: string, v: number) {
  const e = (map[key] ??= { sum: 0, n: 0 });
  e.sum += v;
  e.n += 1;
}

const averages = (m: Record<string, { sum: number; n: number }>): Record<string, Avg> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { avg: Math.round((v.sum / v.n) * 10) / 10, samples: v.n }]));

export async function quotaHistory(runsRoot: string): Promise<QuotaHistory> {
  const tm: Record<string, { sum: number; n: number }> = {};
  const tester: Record<string, { sum: number; n: number }> = {};
  const cost: Record<string, { sum: number; n: number }> = {};
  let runs: string[] = [];
  try {
    runs = await readdir(runsRoot);
  } catch {
    return { byTaskModel: {}, testerByAgent: {}, costByTaskModel: {} };
  }
  for (const run of runs) {
    let jobs: string[] = [];
    try {
      jobs = await readdir(path.join(runsRoot, run));
    } catch {
      continue;
    }
    for (const job of jobs) {
      let j: any;
      try {
        j = JSON.parse(await readFile(path.join(runsRoot, run, job, 'job.json'), 'utf8'));
      } catch {
        continue;
      }
      const u = used(j.phases);
      if (u !== null && j.task?.id && j.model) push(tm, `${j.task.id}|${j.model}`, u);
      const t = used(j.tester?.phases);
      if (t !== null && j.tester?.agent) push(tester, j.tester.agent, t);
      const c = j.split?.total?.costUsd ?? j.measure?.total?.cost?.value;
      if (typeof c === 'number' && j.task?.id && j.model) push(cost, `${j.task.id}|${j.model}`, c);
    }
  }
  return { byTaskModel: averages(tm), testerByAgent: averages(tester), costByTaskModel: averages(cost) };
}

export interface PlannedJob {
  task: string;
  model: string;
  agent: string;
  /** Agent kind of the tester, or null without tester. */
  testerAgent: string | null;
}

export interface Need {
  /** Estimated % of the 5-hour window, from jobs with history. */
  pct: number;
  known: number;
  unknown: number;
}

/** Need per provider (agent kind), counting the tested agent's jobs and the tester sessions it hosts. */
export function estimateNeed(h: QuotaHistory, jobs: PlannedJob[]): Record<string, Need> {
  const out: Record<string, Need> = {};
  const add = (agent: string, v: number | undefined) => {
    const n = (out[agent] ??= { pct: 0, known: 0, unknown: 0 });
    if (v === undefined) n.unknown += 1;
    else {
      n.pct = Math.round((n.pct + v) * 10) / 10;
      n.known += 1;
    }
  };
  for (const j of jobs) {
    add(j.agent, h.byTaskModel[`${j.task}|${j.model}`]?.avg);
    if (j.testerAgent) add(j.testerAgent, h.testerByAgent[j.testerAgent]?.avg);
  }
  return out;
}

export type QuotaVerdict = 'ok' | 'tight' | 'ko' | 'unknown';

/** `remainingPct`: what is left of the 5-hour window now (null when it could not be read). */
export function quotaVerdict(need: Need, remainingPct: number | null): QuotaVerdict {
  if (remainingPct === null || need.known === 0) return 'unknown';
  if (need.pct <= remainingPct * 0.8) return 'ok';
  if (need.pct <= remainingPct) return 'tight';
  return 'ko';
}
