import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Effort, Mode } from '../agents/types.js';
import { adapterFor, pickTester, resolveModel } from '../agents/index.js';
import type { Herdr } from '../herdr/client.js';
import type { AgentPaths } from '../paths.js';
import { findTask } from '../catalog/load.js';
import { detectMachine } from '../detect/machine.js';
import { commandVersion } from '../detect/exec.js';
import { loadPrices } from '../measure/prices.js';
import { runJob, type JobResult } from './job.js';
import { modeLabel } from '../ui/labels.js';
import { tr } from '../i18n.js';

export interface WaveJob {
  model: string;
  mode: Mode;
}

export interface Wave {
  task: string;
  jobs: WaveJob[];
}

/**
 * One project at a time; all selected models run the same project together, each in its own
 * sandbox, so they share the same machine load. Modes bare and harness are separate sub-waves unless
 * `modesTogether`. `sequential`: one job per wave, for a clock without any concurrency.
 */
export function planWaves(o: { tasks: string[]; models: string[]; modes: Mode[]; modesTogether?: boolean; sequential?: boolean }): Wave[] {
  const waves: Wave[] = [];
  for (const task of o.tasks) {
    const groups = o.modesTogether ? [o.modes] : o.modes.map((m) => [m]);
    for (const modes of groups) {
      const jobs = modes.flatMap((mode) => o.models.map((model) => ({ model, mode })));
      if (o.sequential) for (const j of jobs) waves.push({ task, jobs: [j] });
      else waves.push({ task, jobs });
    }
  }
  return waves;
}

export interface BenchPlan {
  tasks: string[];
  models: string[];
  modes: Mode[];
  effort: Effort;
  /** auto | none | model id */
  tester: string;
  maxFixRounds: number;
  modesTogether?: boolean;
  sequential?: boolean;
}

export interface BenchOptions {
  runId: string;
  runsRoot: string;
  plan: BenchPlan;
  herdr: Herdr;
  agentPaths: AgentPaths;
  /** Extra task catalogs (the user's own ideas). */
  catalogRoots?: string[];
  log?: (msg: string) => void;
  /** Live display hooks; default: plain lines through `log`. */
  ui?: BenchUi;
  /** Add jobs to an existing run: run.json is merged, jobs already done are skipped. */
  append?: boolean;
}

export interface BenchUi {
  wave(index: number, total: number, task: string, jobs: WaveJob[]): void;
  job(task: string, model: string, mode: Mode, message: string): void;
  done(task: string, model: string, mode: Mode, result: JobResult): void;
}

/** Runs the whole plan wave by wave, writes `run.json`, and returns every job result. */
export async function runBench(o: BenchOptions): Promise<JobResult[]> {
  const log = o.log ?? (() => {});
  const ui: BenchUi = o.ui ?? {
    wave: (i, n, task, jobs) => log(`${tr('Vague', 'Wave')} ${i}/${n} · ${task} · ${jobs.map((j) => `${j.model} (${modeLabel(j.mode)})`).join(', ')}`),
    job: (task, model, mode, m) => log(`  [${task} · ${model} · ${modeLabel(mode)}] ${m}`),
    done: () => {},
  };
  const runDir = path.join(o.runsRoot, o.runId);
  await mkdir(runDir, { recursive: true });
  const models = o.plan.models.map(resolveModel);
  const done = new Set<string>();
  if (o.append) {
    for (const d of await readdir(runDir).catch(() => [] as string[])) {
      if (await access(path.join(runDir, d, 'job.json')).then(() => true, () => false)) done.add(d);
    }
  }
  const waves = planWaves({ ...o.plan, models })
    .map((w) => ({ ...w, jobs: w.jobs.filter((j) => !done.has(`${w.task}__${j.model.replace(/:/g, '-')}__${j.mode}`)) }))
    .filter((w) => w.jobs.length);
  const [machine, claude, codex, cursor, herdrVersion] = await Promise.all([
    detectMachine(), commandVersion('claude'), commandVersion('codex'), commandVersion('cursor-agent'), commandVersion('herdr'),
  ]);
  let previous: any = null;
  if (o.append) {
    try {
      previous = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8'));
    } catch {
      // A run started with `ailovebench run` has no run.json yet.
    }
  }
  const offset = previous?.waves?.length ?? 0;
  const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
  const runInfo = {
    schema: 1,
    runId: o.runId,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    endedAt: null as string | null,
    machine,
    versions: { claude, codex, cursor, herdr: herdrVersion },
    plan: previous
      ? { ...o.plan, tasks: union(previous.plan?.tasks, o.plan.tasks), models: union(previous.plan?.models, models), modes: union(previous.plan?.modes, o.plan.modes) }
      : { ...o.plan, models },
    waves: [
      ...(previous?.waves ?? []),
      ...waves.map((w, i) => ({ index: offset + i + 1, task: w.task, jobs: w.jobs.map((j) => `${w.task}__${j.model.replace(/:/g, '-')}__${j.mode}`), addedAt: o.append ? new Date().toISOString() : undefined })),
    ],
    /** Each addition to the run, with its own plan, so the report can tell when jobs were added. */
    additions: [...(previous?.additions ?? []), ...(o.append ? [{ at: new Date().toISOString(), plan: { ...o.plan, models } }] : [])],
    pricesUpdatedAt: loadPrices().updated_at,
  };
  const writeRun = () => writeFile(path.join(runDir, 'run.json'), JSON.stringify(runInfo, null, 2) + '\n');
  await writeRun();

  const results: JobResult[] = [];
  for (const [i, wave] of waves.entries()) {
    const task = await findTask(wave.task, o.catalogRoots);
    ui.wave(offset + i + 1, offset + waves.length, task.id, wave.jobs);
    const wr = await Promise.all(
      wave.jobs.map(async (j) => {
        const adapter = adapterFor(j.model);
        const say = (m: string) => ui.job(task.id, j.model, j.mode, m);
        const tester = await pickTester(o.plan.tester, adapter.kind, (m) => say(`⚠️ ${m}`));
        const result = await runJob({
          runId: o.runId, runsRoot: o.runsRoot, task, model: j.model, mode: j.mode, effort: o.plan.effort,
          herdr: o.herdr, adapter, tester, maxFixRounds: o.plan.maxFixRounds, agentPaths: o.agentPaths,
          log: say,
        });
        ui.done(task.id, j.model, j.mode, result);
        return result;
      }),
    );
    results.push(...wr);
  }
  runInfo.endedAt = new Date().toISOString();
  await writeRun();
  return results;
}
