import { LiveBoard } from '../ui/board.js';
import { bold, green, red, yellow } from '../ui/colors.js';
import { runBench, type BenchOptions } from './bench.js';
import type { JobResult } from './job.js';
import { dec, tr } from '../i18n.js';

const verdictText = (v: string): string | undefined =>
  ({
    works: green(`✅ ${tr('fonctionne', 'works')}`),
    works_with_bugs: yellow(`⚠️ ${tr('bugs restants', 'bugs left')}`),
    broken: red(`❌ ${tr('ne fonctionne pas', 'does not work')}`),
    abandoned: red(`⏸ ${tr('abandonné', 'abandoned')}`),
  })[v];

const verdictOf = (r: JobResult) =>
  (r.verdict ? verdictText(r.verdict) : undefined) ?? (r.status === 'completed' ? green(tr('terminé', 'done')) : red(r.status));

/** runBench with colored per-model lines and a live block of running jobs (spinner, step, time). */
export async function runBenchLive(o: Omit<BenchOptions, 'ui' | 'log'>): Promise<JobResult[]> {
  // `append` passes through: jobs already in the run are skipped.
  const board = new LiveBoard();
  board.start();
  try {
    return await runBench({
      ...o,
      ui: {
        wave: (i, n, task, jobs) => {
          board.clearFinished();
          board.log(`\n${bold(`${tr('Vague', 'Wave')} ${i}/${n} · ${task}`)} · ${jobs.map((j) => board.tag(task, j.model, j.mode)).join(' ')}`);
        },
        job: (task, model, mode, m) => board.job(task, model, mode, m),
        done: (task, model, mode, r) => {
          const cost = r.split?.total.costUsd;
          const summary = `${verdictOf(r)}${cost !== null && cost !== undefined ? ` · ≈ ${dec(cost.toFixed(2))} $` : ''}`;
          board.log(`  ${board.tag(task, model, mode)} ${bold(tr('fin', 'end'))} · ${summary}`);
          board.finish(task, model, mode, summary);
        },
      },
    });
  } finally {
    board.stop();
  }
}
