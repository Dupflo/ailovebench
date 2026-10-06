import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../detect/exec.js';
import type { Mode } from '../agents/types.js';
import { tr } from '../i18n.js';

export interface JobRef {
  runId: string;
  taskId: string;
  model: string;
  mode: Mode;
}

export interface JobDirs {
  root: string;
  work: string;
}

/** Folder-safe: « cursor:composer-2.5 » becomes « cursor-composer-2.5 » (no « : » in paths). */
export const jobId = (j: Omit<JobRef, 'runId'>): string => `${j.taskId}__${j.model.replace(/:/g, '-')}__${j.mode}`;

/** `20261001-143005` */
export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * `<runs>/<run-id>/<task>__<model>__<mode>/work`, outside any user project so no parent CLAUDE.md
 * can be loaded, with its own git repo so the produced diff can be inspected.
 */
export async function prepareSandbox(runsRoot: string, job: JobRef, starter: string | null = null): Promise<JobDirs> {
  const root = path.join(runsRoot, job.runId, jobId(job));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  if (starter) await cp(starter, work, { recursive: true });
  if ((await run('git', ['init', '-q', work])) === null) throw new Error(tr(`git init a échoué dans ${work}`, `git init failed in ${work}`));
  // Snapshot of the starting point, so the agent's diff can be inspected afterwards.
  await run('git', ['-C', work, 'add', '-A']);
  await run('git', ['-C', work, '-c', 'user.name=ailovebench', '-c', 'user.email=bench@localhost', 'commit', '-q', '--allow-empty', '-m', 'starter']);
  return { root, work };
}

/**
 * Stops what an agent left running in its sandbox (dev servers, previews): they would hold the
 * usual ports (5173, 4173…) against the next agents, and show up in their process lists.
 */
export async function stopLeftovers(work: string): Promise<void> {
  await run('pkill', ['-f', '--', `${work}/`]).catch(() => {});
}
