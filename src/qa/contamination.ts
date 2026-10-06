import { tr } from '../i18n.js';

/**
 * Did an agent look where it should not? Its transcript (commands, files read, tool output) is
 * searched for the other jobs of the run, other runs, and ailovebench itself (catalog with hidden
 * tests, checks' source). One hit is enough: the result is not comparable any more.
 */
export interface Leak {
  kind: 'other_job' | 'other_run' | 'ailovebench' | 'task_ideas';
  /** What was found, as written in the transcript. */
  target: string;
  count: number;
}

export interface LeakContext {
  /** This job's folder name, e.g. `3d-01__claude-opus-5-5__bare`. */
  ownJob: string;
  /** The other folders of the run (jobs, `_archive`, `_tester`). */
  otherJobs: string[];
  runId: string;
  /** ailovebench's home (`~/.ailovebench`, real path), plus its former location for older runs. */
  benchHomes: string[];
  /** Installed package roots (real path and any symlink to it). */
  packageRoots: string[];
}

/** Read at display time, so it follows the computer's language. */
export const LEAK_LABEL: Record<Leak['kind'], string> = {
  get other_job() { return tr("dossier d'un autre job", "another job's folder"); },
  get other_run() { return tr("dossier d'un autre run", "another run's folder"); },
  get ailovebench() { return tr('code ou catalogue de ailovebench (tests cachés compris)', "ailovebench's code or catalog (hidden tests included)"); },
  get task_ideas() { return tr('idées de tâches de ailovebench', "ailovebench's task ideas"); },
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** JSON transcripts escape `/` sometimes; search the text both ways. */
const unescape = (text: string) => text.replace(/\\\//g, '/');

export function findLeaks(rawText: string, c: LeakContext): Leak[] {
  const text = unescape(rawText);
  const leaks: Leak[] = [];
  const add = (kind: Leak['kind'], target: string, count: number) => {
    if (count) leaks.push({ kind, target, count });
  };
  const count = (re: RegExp) => (text.match(re) ?? []).length;

  for (const other of c.otherJobs) {
    if (other === c.ownJob) continue;
    // Job names end with their mode (`__bare`), so `…medium__bare` never matches inside `…medium-fast__bare`.
    // A server of another job seen in a process list (`ps`, `lsof` on a busy port) is not a read.
    add('other_job', other, count(new RegExp(`(?<![\\w.-])${escape(other)}(?![\\w.-])(?!/work/node_modules/\\.bin/)`, 'g')));
  }
  const runs = new Map<string, number>();
  for (const home of c.benchHomes) {
    for (const m of text.matchAll(new RegExp(`${escape(home)}/runs/(\\d{8}-\\d{6})`, 'g'))) {
      if (m[1] !== c.runId) runs.set(m[1]!, (runs.get(m[1]!) ?? 0) + 1);
    }
  }
  for (const [id, n] of runs) add('other_run', `runs/${id}`, n);
  for (const home of c.benchHomes) add('task_ideas', `${home}/catalog`, count(new RegExp(escape(`${home}/catalog`), 'g')));
  for (const root of new Set(c.packageRoots)) add('ailovebench', root, count(new RegExp(`${escape(root)}(?=[/'"\\s]|$)`, 'g')));
  return leaks;
}
