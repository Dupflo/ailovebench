import { bold, colorEnabled, dim, modelColor } from './colors.js';
import { modeLabel } from './labels.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Row {
  task: string;
  model: string;
  mode: string;
  state: string;
  startedAt: number;
  endedAt?: number;
  done: boolean;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')}` : `${s} s`;
}

/**
 * Log lines scroll as usual; below them, a live block shows every running job with a spinner,
 * its current step and elapsed time. Without a TTY it falls back to plain lines.
 */
export class LiveBoard {
  private rows = new Map<string, Row>();
  private drawn = 0;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private live = colorEnabled();

  start(): void {
    if (!this.live || this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.redraw();
    }, 120);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  /** Colored tag for a job: `[web-01 · gpt-6-astra · bare]`. */
  tag(task: string, model: string, mode: string): string {
    return modelColor(model)(`[${task} · ${model} · ${modeLabel(mode)}]`);
  }

  /** A permanent line above the live block. */
  log(line: string): void {
    this.clear();
    process.stdout.write(`${line}\n`);
    this.redraw();
  }

  /** Permanent line for a job + its live state. */
  job(task: string, model: string, mode: string, message: string): void {
    const key = `${task}|${model}|${mode}`;
    const row = this.rows.get(key) ?? { task, model, mode, state: '', startedAt: Date.now(), done: false };
    row.state = message;
    this.rows.set(key, row);
    this.log(`  ${this.tag(task, model, mode)} ${message}`);
  }

  finish(task: string, model: string, mode: string, verdict: string): void {
    const row = this.rows.get(`${task}|${model}|${mode}`);
    if (row) {
      row.done = true;
      row.endedAt = Date.now();
      row.state = verdict;
    }
    this.redraw();
  }

  /** Drops finished jobs from the live block (at the end of a wave). */
  clearFinished(): void {
    for (const [k, r] of this.rows) if (r.done) this.rows.delete(k);
    this.redraw();
  }

  private clear(): void {
    if (!this.live || !this.drawn) return;
    process.stdout.write(`\x1b[${this.drawn}A\x1b[0J`);
    this.drawn = 0;
  }

  private redraw(): void {
    if (!this.live) return;
    this.clear();
    const rows = [...this.rows.values()];
    if (!rows.length) return;
    const width = process.stdout.columns ?? 120;
    const lines = [dim('─'.repeat(Math.min(width, 80))), ...rows.map((r) => {
      const icon = r.done ? '✔' : FRAMES[this.frame]!;
      const head = `${icon} ${r.task} · ${r.model} · ${modeLabel(r.mode)}`;
      const time = elapsed((r.endedAt ?? Date.now()) - r.startedAt);
      // Keep each row on one terminal line, or the cursor maths of the redraw break.
      const room = Math.max(10, width - head.length - time.length - 6);
      const state = r.state.length > room ? `${r.state.slice(0, room - 1)}…` : r.state;
      return `${modelColor(r.model)(head)}  ${dim(time)}  ${r.done ? bold(state) : state}`;
    })];
    process.stdout.write(`${lines.join('\n')}\n`);
    this.drawn = lines.length;
  }
}
