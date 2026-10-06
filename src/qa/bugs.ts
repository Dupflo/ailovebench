import type { ChecksRun } from '../checks/run.js';
import type { Bucket } from '../measure/aggregate.js';
import type { JobStatus } from '../runner/job.js';
import { tr } from '../i18n.js';

/**
 * `inconclusive`: after a fix, the script crashed instead of asserting — not sent back to the agent.
 * `remark`: a confirmed defect outside the spec — reported, never sent back, never counted in the verdict.
 */
export type BugStatus = 'confirmed' | 'unconfirmed' | 'fixed' | 'remaining' | 'regression' | 'inconclusive' | 'remark';

/** `spec`: the product does not do what the spec asked. `outside`: a defect the spec did not cover. */
export type BugScope = 'spec' | 'outside';

export interface Bug {
  id: string;
  /** `check`: a failed automatic check. `tester`: found by the tester agent, with a script. */
  source: 'check' | 'tester';
  /** Sent to the agent in fix prompts: the canonical text, the same on every machine. */
  title: string;
  /** English title for display, when the bug comes from a translated check (see `bugTitle`). */
  titleEn?: string;
  scope: BugScope;
  checkId?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  severity?: 'bloquant' | 'majeur' | 'mineur';
  /** Reproduction script (tester bugs), relative to the job folder. Never shown to the tested agent. */
  script?: string;
  status: BugStatus;
  foundInRound: number;
  fixedInRound?: number;
}

/** Bugs the tested agent still has to fix. */
export const isOpen = (b: Bug) => b.status === 'confirmed' || b.status === 'remaining' || b.status === 'regression';

/** What people read: the title in the computer's language. */
export const bugTitle = (b: Pick<Bug, 'title' | 'titleEn'>): string => tr(b.title, b.titleEn ?? b.title);

const failed = (qa: ChecksRun) => qa.results.filter((r) => r.status === 'fail');

/** Failed checks are bugs by construction: they are reproduced by the check itself. Tool errors are not. */
export function bugsFromChecks(qa: ChecksRun): Bug[] {
  return failed(qa).map((r) => ({
    id: `C-${r.id}`,
    source: 'check' as const,
    scope: 'spec' as const,
    checkId: r.id,
    title: r.label,
    ...(r.labelEn ? { titleEn: r.labelEn } : {}),
    ...(r.detail ? { actual: r.detail } : {}),
    status: 'confirmed' as const,
    foundInRound: qa.round,
  }));
}

/**
 * After fix round `round`: check bugs are fixed when their check passes again, tester bugs when
 * their script no longer reproduces them (`stillPresent[id] === false`); a script that crashed
 * (`null`) makes the bug inconclusive. A check that passed in round 0 and fails now is a regression.
 */
export function updateBugs(
  bugs: Bug[],
  round0: ChecksRun,
  current: ChecksRun,
  stillPresent: Record<string, boolean | null>,
  round: number,
): Bug[] {
  const status = new Map(current.results.map((r) => [r.id, r]));
  const out = bugs.map((b): Bug => {
    if (!isOpen(b)) return b;
    if (b.source === 'tester' && stillPresent[b.id] === null) return { ...b, status: 'inconclusive' };
    const present = b.source === 'check' ? status.get(b.checkId!)?.status === 'fail' : stillPresent[b.id] !== false;
    if (!present) return { ...b, status: 'fixed', fixedInRound: round };
    const detail = b.source === 'check' ? status.get(b.checkId!)?.detail : undefined;
    return { ...b, status: b.status === 'regression' ? 'regression' : 'remaining', ...(detail ? { actual: detail } : {}) };
  });

  const passedBefore = new Set(round0.results.filter((r) => r.status === 'pass').map((r) => r.id));
  const known = new Set(out.map((b) => b.id));
  for (const r of failed(current)) {
    const id = `C-${r.id}`;
    if (passedBefore.has(r.id) && !known.has(id)) {
      out.push({ id, source: 'check', scope: 'spec', checkId: r.id, title: r.label, ...(r.labelEn ? { titleEn: r.labelEn } : {}), ...(r.detail ? { actual: r.detail } : {}), status: 'regression', foundInRound: round });
    }
  }
  return out;
}

/** The bug report sent to the tested agent, in its own session. Reproduction scripts stay hidden. */
export function fixPrompt(open: Bug[], round: number): string {
  const lines = [
    `# Retours de recette (tour ${round})`,
    '',
    `La recette de ton travail a relevé ${open.length} problème${open.length > 1 ? 's' : ''}. Corrige-les sans casser le reste.`,
    '',
  ];
  open.forEach((b, i) => {
    lines.push(`## ${i + 1}. ${b.title}${b.status === 'regression' ? ' (régression : ça marchait avant)' : ''}`);
    if (b.steps?.length) lines.push('', 'Étapes pour reproduire :', ...b.steps.map((s, k) => `${k + 1}. ${s}`));
    if (b.expected) lines.push('', `Attendu : ${b.expected}`);
    if (b.actual) lines.push('', 'Observé :', '```', b.actual.slice(0, 4000), '```');
    lines.push('');
  });
  lines.push('Quand tout est corrigé et vérifié, termine par une seule ligne : « TERMINÉ ».');
  return lines.join('\n');
}

export type Verdict = 'works' | 'works_with_bugs' | 'broken' | 'abandoned';

/** `buildOk`: the product still builds/runs after the last round. */
export function verdictOf(status: JobStatus, bugs: Bug[], buildOk: boolean): Verdict {
  if (status !== 'completed') return 'abandoned';
  if (!buildOk) return 'broken';
  return bugs.some(isOpen) ? 'works_with_bugs' : 'works';
}

export interface CostSplit {
  initial: { costUsd: number | null; timeMs: number };
  rework: { costUsd: number | null; timeMs: number };
  total: { costUsd: number | null; timeMs: number };
  /** Rework cost as a share of the initial cost (0.54 = +54 %). */
  reworkShare: number | null;
}

/** Initial build vs fix rounds, from the per-phase measure and the phase timestamps. */
export function costSplit(
  byPhase: Array<Bucket & { phase: string }>,
  phases: Array<{ name: string; startedAt: string; endedAt: string }>,
): CostSplit {
  const cost = (pred: (p: string) => boolean) => {
    // A phase the agent ran but whose usage was never reported (e.g. a Cursor turn cut by the
    // timeout) is unknown, not free.
    const unmeasured = phases.some((p) => pred(p.name) && !byPhase.some((b) => b.phase === p.name));
    const vals = byPhase.filter((b) => pred(b.phase)).map((b) => b.cost.value);
    return unmeasured || vals.some((v) => v === null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0);
  };
  const time = (pred: (p: string) => boolean) =>
    phases.filter((p) => pred(p.name)).reduce((s, p) => s + (Date.parse(p.endedAt) - Date.parse(p.startedAt)), 0);
  const isBuild = (p: string) => p === 'build';
  const isFix = (p: string) => p.startsWith('fix-');
  const initial = { costUsd: cost(isBuild), timeMs: time(isBuild) };
  const rework = { costUsd: cost(isFix), timeMs: time(isFix) };
  // An unknown part makes the total unknown: a missing price must never read as « 0 $ ».
  const total = {
    costUsd: initial.costUsd === null || rework.costUsd === null ? null : initial.costUsd + rework.costUsd,
    timeMs: initial.timeMs + rework.timeMs,
  };
  return {
    initial,
    rework,
    total,
    reworkShare: initial.costUsd ? (rework.costUsd ?? 0) / initial.costUsd : null,
  };
}
