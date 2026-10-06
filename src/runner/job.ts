import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, Effort, Mode } from '../agents/types.js';
import type { Herdr } from '../herdr/client.js';
import type { Task } from '../catalog/load.js';
import type { AgentPaths } from '../paths.js';
import { loadPrices } from '../measure/prices.js';
import type { Summary } from '../measure/aggregate.js';
import type { HarnessUse } from '../measure/types.js';
import { jobId, prepareSandbox, stopLeftovers } from './sandbox.js';
import { AgentSession, type PhaseRecord } from './session.js';
import { runChecks, type ChecksRun } from '../checks/run.js';
import { withBrowser } from '../checks/browser.js';
import { serveStatic } from '../checks/serve.js';
import { runBugScript } from '../qa/repro.js';
import type { Isolation } from './jail.js';
import { knownBugStatus, type KnownBugStatus } from '../qa/known-bugs.js';
import { bugsFromChecks, costSplit, fixPrompt, isOpen, updateBugs, verdictOf, type Bug, type CostSplit, type Verdict } from '../qa/bugs.js';
import { runTester, type TesterConfig, type TesterResult } from '../qa/tester.js';
import { tr } from '../i18n.js';

export type { PhaseRecord } from './session.js';

export type JobStatus = 'completed' | 'blocked' | 'stalled' | 'timeout' | 'quota_paused' | 'error';

export const MAX_FIX_ROUNDS = 3;

export interface JobResult {
  schema: 2;
  id: string;
  runId: string;
  task: { id: string; title: string; category: string; promptHash: string };
  agent: string;
  model: string;
  /** Model ids actually seen in the transcript (can differ from the requested alias). */
  modelsSeen: string[];
  mode: Mode;
  effort: Effort;
  sessionId: string;
  workDir: string;
  status: JobStatus;
  /** build, then fix-1 … fix-3, all in the same agent session. */
  phases: PhaseRecord[];
  measure: Summary | null;
  /** Skills and MCP servers of the user's harness actually used (empty without harness). */
  harness?: HarnessUse;
  /** QA rounds: 0 right after the build, then one per fix round. Not counted in the agent's time. */
  qa: ChecksRun[];
  tester: Omit<TesterResult, 'bugs'> | null;
  bugs: Bug[];
  /** sandbox: the agent could not read other jobs, runs, nor ailovebench's checks (see jail.ts). */
  isolation?: Isolation;
  /** Repair tasks: the bugs planted in the starter, detected on it, then fixed or not. */
  knownBugs?: KnownBugStatus[];
  verdict: Verdict | null;
  /** Initial build vs rework (fix rounds): cost and agent time. */
  split: CostSplit | null;
  /** Date of the price table used for the cost estimate. */
  pricesUpdatedAt: string;
  startedAt: string;
  endedAt: string;
}

export interface JobOptions {
  runId: string;
  runsRoot: string;
  task: Task;
  model: string;
  mode: Mode;
  /** Same for the tested agent and the tester. Default: medium. */
  effort?: Effort;
  herdr: Herdr;
  adapter: AgentAdapter;
  agentPaths: AgentPaths;
  /** Black-box tester from another provider; null = automatic checks only. */
  tester?: TesterConfig | null;
  maxFixRounds?: number;
  keepWorkspace?: boolean;
  /** Skip all QA (tests of the runner itself). */
  skipChecks?: boolean;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * One (task × model × mode) job: sandbox → agent builds → QA (checks + tester) → the same agent
 * fixes confirmed bugs, up to 3 rounds, each re-checked → measure → job.json.
 */
export async function runJob(o: JobOptions): Promise<JobResult> {
  const log = o.log ?? (() => {});
  const now = () => (o.now ?? (() => new Date()))().toISOString();
  const ref = { runId: o.runId, taskId: o.task.id, model: o.model, mode: o.mode };
  const id = jobId(ref);
  const dirs = await prepareSandbox(o.runsRoot, ref, o.task.starter);
  log(`${tr('bac à sable', 'sandbox')} : ${dirs.work}`);

  const result: JobResult = {
    schema: 2,
    id,
    runId: o.runId,
    task: {
      id: o.task.id,
      title: o.task.title,
      category: o.task.category,
      promptHash: `sha256:${createHash('sha256').update(o.task.prompt).digest('hex')}`,
    },
    agent: o.adapter.kind,
    model: o.model,
    modelsSeen: [],
    mode: o.mode,
    effort: o.effort ?? 'medium',
    sessionId: '',
    workDir: dirs.work,
    status: 'error',
    phases: [],
    measure: null,
    qa: [],
    tester: null,
    bugs: [],
    verdict: null,
    split: null,
    pricesUpdatedAt: loadPrices().updated_at,
    startedAt: now(),
    endedAt: '',
  };

  let session: AgentSession | null = null;
  try {
    session = await AgentSession.open({
      herdr: o.herdr, adapter: o.adapter, agentPaths: o.agentPaths, root: dirs.root, cwd: dirs.work,
      mode: o.mode, model: o.model, effort: o.effort ?? 'medium', label: `bm ${id}`, log, ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.now ? { now: o.now } : {}),
    });
    result.sessionId = session.sessionId;
    result.isolation = session.isolation;

    result.status = statusOf(await session.prompt('build', o.task.prompt, o.task.timeoutMin));
    if (result.status === 'completed' && !o.skipChecks && o.task.checks.length) {
      await qualityLoop(o, session, dirs, result, log);
    }
  } catch (err) {
    log(`${tr('erreur', 'error')} : ${err instanceof Error ? err.message : err}`);
    result.status = 'error';
  } finally {
    result.endedAt = now();
    if (session) {
      result.phases = session.phases;
      const measured = await session.measure();
      if (measured) {
        for (const p of result.phases) if (measured.phaseSummaries[p.name]) p.summary = measured.phaseSummaries[p.name];
        result.sessionId = measured.sessionId;
        result.harness = measured.harness;
        result.measure = measured.summary;
        result.modelsSeen = measured.models;
        result.split = costSplit(measured.summary.byPhase, result.phases);
      }
      await session.close(o.keepWorkspace);
    }
    await stopLeftovers(dirs.work);
    if (result.qa.length) {
      const last = result.qa.at(-1)!;
      const buildOk = !last.results.some((r) => r.id === 'build' && r.status !== 'pass');
      result.verdict = verdictOf(result.status, result.bugs, buildOk);
      if (o.task.knownBugs.length) result.knownBugs = knownBugStatus(o.task.knownBugs, result.qa[0]!.baseline, last);
    }
    await writeFile(path.join(dirs.root, 'job.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function qualityLoop(
  o: JobOptions,
  session: AgentSession,
  dirs: { root: string; work: string },
  result: JobResult,
  log: (msg: string) => void,
): Promise<void> {
  log(`QA round 0 : ${tr('checks automatiques…', 'automatic checks…')}`);
  const qa0 = await runChecks(o.task, dirs.root, dirs.work, 0);
  result.qa.push(qa0);
  result.bugs = bugsFromChecks(qa0);
  log(`QA round 0 : ${qa0.passed} ok · ${qa0.failed} ${tr('en échec', 'failing')}`);

  const staticDir = o.task.deliverable ? path.join(dirs.work, o.task.deliverable.static_dir) : null;
  const built = !qa0.results.some((r) => r.id === 'build' && r.status !== 'pass');
  if (o.tester && staticDir && built) {
    log(`QA round 0 : ${tr('recette par', 'testing by')} ${o.tester.adapter.kind} ${o.tester.model}…`);
    const t = await runTester({
      task: o.task, staticDir, jobRoot: dirs.root, sandboxRoot: path.join(o.runsRoot, o.runId, '_tester'),
      tester: o.tester, effort: o.effort ?? 'medium', herdr: o.herdr, agentPaths: o.agentPaths, log,
    });
    const { bugs, ...rest } = t;
    result.tester = rest;
    result.bugs.push(...bugs);
  }

  const maxRounds = o.maxFixRounds ?? MAX_FIX_ROUNDS;
  for (let round = 1; round <= maxRounds && result.bugs.some(isOpen); round++) {
    const open = result.bugs.filter(isOpen);
    log(`fix-${round} : ${open.length} ${tr("bug(s) renvoyé(s) à l'agent", 'bug(s) sent back to the agent')}`);
    const phase = await session.prompt(`fix-${round}`, fixPrompt(open, round), o.task.timeoutMin);
    phase.bugsSent = open.map((b) => b.id);
    result.status = statusOf(phase);
    if (result.status !== 'completed') break;

    const qa = await runChecks(o.task, dirs.root, dirs.work, round);
    result.qa.push(qa);
    const stillPresent = await replayTesterBugs(open, dirs.root, staticDir);
    result.bugs = updateBugs(result.bugs, qa0, qa, stillPresent, round);
    const fixed = result.bugs.filter((b) => b.fixedInRound === round).length;
    const regressions = result.bugs.filter((b) => b.status === 'regression' && b.foundInRound === round).length;
    log(`QA round ${round} : ${fixed} ${tr('corrigé(s)', 'fixed')} · ${result.bugs.filter(isOpen).length} ${tr('ouvert(s)', 'open')} · ${regressions} ${tr('régression(s)', 'regression(s)')}`);
  }
}

/** Re-runs the reproduction scripts of open tester bugs on the rebuilt product. */
async function replayTesterBugs(open: Bug[], jobRoot: string, staticDir: string | null): Promise<Record<string, boolean | null>> {
  const tester = open.filter((b) => b.source === 'tester' && b.script);
  if (!tester.length || !staticDir) return {};
  const server = await serveStatic(staticDir);
  try {
    return await withBrowser(async (browser) => {
      const out: Record<string, boolean | null> = {};
      for (const b of tester) out[b.id] = (await runBugScript(browser, path.join(jobRoot, b.script!), server.url)).present;
      return out;
    });
  } finally {
    await server.close();
  }
}

export function statusOf(p: PhaseRecord): JobStatus {
  if (p.problem?.kind === 'quota') return 'quota_paused';
  if (p.problem?.kind === 'api_error') return 'error';
  switch (p.outcome) {
    case 'done':
    case 'idle':
      return 'completed';
    case 'blocked':
      return 'blocked';
    case 'stalled':
      return 'stalled';
    case 'timeout':
      return 'timeout';
    default:
      return 'error';
  }
}
