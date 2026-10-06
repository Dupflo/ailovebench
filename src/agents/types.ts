import type { AgentPaths } from '../paths.js';
import type { ParsedSession } from '../measure/types.js';

export type Mode = 'bare' | 'harness';

/** Accepts the names used before the public release ('nu', 'equipe') for older runs and scripts. */
export function normalizeMode(m: string): Mode | null {
  const names: Record<string, Mode> = { bare: 'bare', harness: 'harness', nu: 'bare', equipe: 'harness' };
  return names[m] ?? null;
}

/** Reasoning effort, set explicitly and identically for every agent so defaults never bias a run. */
export type Effort = 'low' | 'medium' | 'high';

export interface QuotaReading {
  /** % used of the 5-hour window. */
  window5hPct: number | null;
  /** % used of the weekly window. */
  weekPct: number | null;
  source: 'measured' | 'estimated';
  /** Plan shown next to the usage, when the screen gives it. */
  plan?: string;
}

export interface ScreenProblem {
  kind: 'quota' | 'api_error';
  detail: string;
}

export interface PrepareContext {
  /** `<runs>/<run>/<job>`: holds the work folder, job.json and any per-job agent home. */
  root: string;
  work: string;
  mode: Mode;
  /** The user's own Codex home (only used by the Codex adapter). */
  userCodexHome?: string;
}

export interface Prepared {
  /** Environment for the agent's shell (set on the herdr workspace). */
  env: Record<string, string>;
  /** Runs after the job, whatever its outcome. */
  cleanup(): Promise<void>;
}

export interface LocateContext {
  work: string;
  sessionId: string;
  mode: Mode;
  env: Record<string, string>;
  paths: AgentPaths;
}

/** What the runner needs to know about one interactive agent CLI. */
export interface AgentAdapter {
  /** herdr `--kind`. */
  kind: string;
  prepare(ctx: PrepareContext): Promise<Prepared>;
  launchArgs(opts: { mode: Mode; model: string; sessionId: string; work: string; effort: Effort }): string[];
  /** Keys that answer a modal question (folder trust, model switch…), or null when nothing to answer. */
  startupKeys(screen: string): string[] | null;
  /** True when the input prompt is displayed and the agent accepts a prompt. */
  isReady(screen: string): boolean;
  /** Problems herdr does not report as blocked: API errors, usage limits. */
  screenProblem(screen: string): ScreenProblem | null;
  /** Slash command showing subscription usage, its parser, and the keys that close it. */
  usageCommand: string;
  parseUsage(screen: string): QuotaReading | null;
  usageDismissKeys: string[];
  locateTranscript(ctx: LocateContext): Promise<string | null>;
  parseTranscript(file: string): Promise<ParsedSession>;
  /**
   * Agents driven in script mode (Cursor): one command per phase, run in the herdr pane, its output
   * streamed to a file. No interactive prompt, no usage screen.
   */
  headless?: {
    command(o: { model: string; sessionId: string | null; promptFile: string; outFile: string }): string;
    /** Reads one phase's output: the session to resume next, and any problem to report. */
    readPhase(outFile: string): Promise<{ sessionId: string | null; problem: ScreenProblem | null; ok: boolean }>;
    /** Parses every phase output of the session (in order) for the measure. */
    parsePhases(files: Array<{ phase: string; file: string }>, model: string): Promise<ParsedSession>;
  };
}
