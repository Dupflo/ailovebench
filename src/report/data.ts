import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { JobResult } from '../runner/job.js';
import { costSplit, verdictOf } from '../qa/bugs.js';
import { adapterFor } from '../agents/index.js';
import { normalizeMode } from '../agents/types.js';
import { benchHome, defaultAgentPaths, legacyBenchHomes, packageRoot } from '../paths.js';
import { findLeaks, type Leak, type LeakContext } from '../qa/contamination.js';
import { phaseSummaries } from '../measure/summaries.js';
import { agentSeries, type SeriesPoint } from './series.js';
import { assignPhases, summarize } from '../measure/aggregate.js';
import { loadPrices } from '../measure/prices.js';

/**
 * Reads the job's transcript once: the curves (cost / tokens over agent time) for the charts, and
 * for older jobs the agent's summaries and harness use, which they did not store.
 */
async function readTranscript(job: JobResult & { series?: SeriesPoint[]; leaks?: Leak[] }, dir: string, leakCtx?: LeakContext): Promise<void> {
  if (!job.phases?.length) return;
  const scan = async (files: string[]) => {
    if (!leakCtx) return;
    const text = (await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')))).join('\n');
    job.leaks = findLeaks(text, leakCtx);
  };
  try {
    const adapter = adapterFor(job.model);
    if (adapter.headless) {
      // Script-mode agents (Cursor): the bench saved each phase's stream next to the job.
      const files = job.phases.map((p) => ({ phase: p.name, file: path.join(dir, 'phases', `${p.name}.jsonl`) }));
      await scan(files.map((f) => f.file));
      const parsed = await adapter.headless.parsePhases(files, job.model);
      job.series = agentSeries(parsed.requests, job.phases, loadPrices());
      const summaries = phaseSummaries(parsed.messages, job.phases);
      for (const p of job.phases) p.summary ??= summaries[p.name];
      job.harness ??= parsed.harness;
      // Priced again when the job was measured before its model had a price.
      if (job.measure && job.measure.total.cost.value === null) {
        job.measure = summarize(loadPrices(), assignPhases(parsed.requests, job.phases.map((p) => ({ name: p.name, at: p.startedAt }))));
        job.split = costSplit(job.measure.byPhase, job.phases);
      }
      return;
    }
    const env: Record<string, string> = adapter.kind === 'codex' && job.mode === 'bare' ? { CODEX_HOME: path.join(dir, 'codex-home') } : {};
    const file = await adapter.locateTranscript({ work: job.workDir, sessionId: job.sessionId, mode: job.mode, env, paths: defaultAgentPaths() });
    if (!file) return;
    await scan([file]);
    const parsed = await adapter.parseTranscript(file);
    job.series = agentSeries(parsed.requests, job.phases, loadPrices());
    const summaries = phaseSummaries(parsed.messages, job.phases);
    for (const p of job.phases) p.summary ??= summaries[p.name];
    job.harness ??= parsed.harness;
  } catch {
    // The transcript may have been cleaned up: the report simply shows no summary.
  }
}

/** Older jobs did not record which bugs each fix round received: rebuild it from the bug history. */
function backfillBugsSent(job: JobResult): void {
  for (const p of job.phases ?? []) {
    const round = Number(p.name.match(/^fix-(\d+)$/)?.[1]);
    if (!round || p.bugsSent) continue;
    p.bugsSent = (job.bugs ?? [])
      .filter((b) => b.foundInRound < round && ['confirmed', 'remaining', 'regression', 'fixed'].includes(b.status))
      .filter((b) => b.fixedInRound === undefined || b.fixedInRound >= round)
      .map((b) => b.id);
  }
}

export interface RunData {
  runDir: string;
  runId: string;
  startedAt: string | null;
  machine: Record<string, any> | null;
  versions: Record<string, string | null> | null;
  waves: Array<{ index: number; task: string; jobs: string[] }>;
  /** The bench plan (run.json), or null for a single `ailovebench run`. */
  plan: Record<string, any> | null;
  pricesUpdatedAt: string | null;
  jobs: Array<JobResult & { dir: string; stack: string[]; series?: SeriesPoint[]; leaks?: Leak[] }>;
}

/** Libraries worth naming in the "Stack" column, in display order. */
const NOTABLE = ['react', 'vue', 'svelte', 'solid-js', 'preact', 'astro', 'next', 'nuxt', 'three', 'vite', 'esbuild', 'webpack', 'parcel', 'tailwindcss', 'gsap', 'typescript'];

async function stackOf(work: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(work, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const notable = NOTABLE.filter((n) => deps.includes(n));
    return notable.length ? notable : deps.length ? deps.slice(0, 3) : ['HTML/CSS/JS'];
  } catch {
    return [];
  }
}

/** Stored verdict, or for older jobs one derived from their last QA round. */
export function deriveVerdict(job: Partial<JobResult>): JobResult['verdict'] {
  if (job.verdict) return job.verdict;
  const last = job.qa?.at(-1);
  if (!last) return null;
  if (last.results.some((r) => r.status === 'fail')) return 'works_with_bugs';
  return verdictOf(job.status ?? 'error', job.bugs ?? [], !last.results.some((r) => r.id === 'build' && r.status !== 'pass'));
}

/** Reads `run.json` (when the run came from the bench) and every `job.json` of a run folder. */
export async function loadRun(runDir: string): Promise<RunData> {
  let info: any = {};
  try {
    info = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
  } catch {
    // A single `ailovebench run` has no run.json: the jobs are enough.
  }
  const jobs: RunData['jobs'] = [];
  const entries = (await readdir(runDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const home = await realpath(benchHome()).catch(() => benchHome());
  const leakBase = {
    otherJobs: entries.filter((e) => e !== 'report'),
    runId: info.runId ?? path.basename(runDir),
    benchHomes: [home, ...legacyBenchHomes()],
    packageRoots: [await realpath(packageRoot()).catch(() => packageRoot()), 'node_modules/ailovebench', 'node_modules/ilovebench', 'node_modules/benchmyself'],
  };
  for (const entry of entries) {
    try {
      const job = JSON.parse(await readFile(path.join(runDir, entry, 'job.json'), 'utf8')) as JobResult;
      job.mode = normalizeMode(job.mode) ?? job.mode;
      // Jobs written before the fix loop existed: derive what the report needs.
      job.bugs ??= [];
      // Recomputed: older jobs had none, and an unmeasured phase used to read as « 0 $ ».
      if (job.measure) job.split = costSplit(job.measure.byPhase, job.phases ?? []);
      job.verdict = deriveVerdict(job);
      await readTranscript(job, path.join(runDir, entry), { ...leakBase, ownJob: entry });
      backfillBugsSent(job);
      jobs.push({ ...job, dir: path.join(runDir, entry), stack: await stackOf(job.workDir) });
    } catch {
      // Not a job folder (report/, _tester/…).
    }
  }
  return {
    runDir,
    runId: info.runId ?? path.basename(runDir),
    startedAt: info.startedAt ?? jobs[0]?.startedAt ?? null,
    machine: info.machine ?? null,
    versions: info.versions ?? null,
    waves: info.waves ?? [],
    plan: info.plan ?? null,
    pricesUpdatedAt: info.pricesUpdatedAt ?? jobs[0]?.pricesUpdatedAt ?? null,
    jobs,
  };
}

export interface RunSummary {
  runId: string;
  runDir: string;
  jobs: number;
  tasks: string[];
  models: string[];
  /** Jobs whose product works at the end. */
  works: number;
  hasReport: boolean;
}

/** Runs of `runsRoot` that contain at least one job, newest first (run ids sort by date). */
export async function listRecentRuns(runsRoot: string, limit = 15): Promise<RunSummary[]> {
  let ids: string[] = [];
  try {
    ids = (await readdir(runsRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const runId of ids.sort().reverse()) {
    if (out.length >= limit) break;
    const runDir = path.join(runsRoot, runId);
    const entries = await readdir(runDir, { withFileTypes: true });
    const jobs: any[] = [];
    for (const e of entries.filter((d) => d.isDirectory())) {
      try {
        jobs.push(JSON.parse(await readFile(path.join(runDir, e.name, 'job.json'), 'utf8')));
      } catch {
        // Not a job folder.
      }
    }
    if (!jobs.length) continue;
    out.push({
      runId,
      runDir,
      jobs: jobs.length,
      tasks: [...new Set(jobs.map((j) => j.task?.id as string))].sort(),
      models: [...new Set(jobs.map((j) => j.model as string))].sort(),
      works: jobs.filter((j) => deriveVerdict(j) === 'works').length,
      hasReport: entries.some((d) => d.name === 'report'),
    });
  }
  return out;
}

/** Deletes one run folder, only if it really is a run inside `runsRoot`. */
export async function deleteRun(runsRoot: string, runId: string): Promise<void> {
  if (!/^\d{8}-\d{6}$/.test(runId)) throw new Error(`identifiant de run invalide : ${runId}`);
  const dir = path.join(runsRoot, runId);
  if (path.dirname(dir) !== path.resolve(runsRoot)) throw new Error('chemin hors du dossier des runs');
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
  // The anonymous tester folders live inside the run: nothing else to clean.
}
