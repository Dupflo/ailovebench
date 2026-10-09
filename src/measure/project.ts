import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentPaths } from '../paths.js';
import { rolloutsNewestFirst } from '../detect/subscriptions.js';
import { parseClaudeSession } from './transcripts/claude.js';
import { parseCodexRollout } from './transcripts/codex.js';
import { normalizeModelId, priceTableAge, type PriceTable, type PriceTableAge } from './prices.js';
import { summarize, type Bucket, type PhasedRequest, type Summary } from './aggregate.js';
import type { ModelRequest } from './types.js';

/**
 * Cost of a whole project folder: every Claude Code and Codex session (CLI, desktop apps, exec,
 * subagents) whose working directory is the folder or one of its subfolders.
 *
 * Sessions are matched on the `cwd` written in the transcripts, never on Claude's folder slug,
 * so it works the same on Windows. Only numbers and model names leave this module: prompts and
 * answers are read by the parsers but never returned.
 */

export type Tool = 'claude' | 'codex';

export interface ProjectSessionFile {
  tool: Tool;
  file: string;
  cwd: string;
}

export interface ProjectReport {
  dir: string;
  since: string | null;
  until: string | null;
  /** First and last request counted. */
  start: string | null;
  end: string | null;
  /** Time with requests less than ACTIVE_GAP_MS apart: pauses and nights are left out. */
  activeMs: number;
  sessions: { total: number; claude: number; codex: number };
  summary: Summary;
  byTool: Array<Bucket & { tool: Tool }>;
  /** `summary.byModel`, with the tool(s) each model was used in. */
  byModel: Array<Bucket & { model: string; tools: Tool[] }>;
  prices: PriceTableAge & { maxAgeDays: number };
}

/** A gap longer than this between two requests counts as a pause. */
export const ACTIVE_GAP_MS = 15 * 60_000;

/** Is `cwd` the project folder or inside it? Case- and separator-insensitive on Windows. */
export function isInside(dir: string, cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => {
    const r = p.resolve(s);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = p.relative(norm(dir), norm(cwd));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** Reads a transcript only until its first `cwd`, so scanning every session stays fast. */
async function firstCwd(file: string, tool: Tool, maxLines = 200): Promise<string | null> {
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      if (++n > maxLines) break;
      if (!line.includes('"cwd"')) continue;
      try {
        const j = JSON.parse(line);
        const cwd = tool === 'claude' ? j.cwd : j.type === 'session_meta' ? j.payload?.cwd : undefined;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // A partially written line.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Every Claude and Codex transcript whose working directory is `dir` or a subfolder of it. */
export async function findProjectSessions(dir: string, paths: AgentPaths): Promise<ProjectSessionFile[]> {
  const candidates: Array<{ tool: Tool; file: string }> = [];
  // Claude: <projects>/<slug>/<session>.jsonl; subagents (<session>/subagents/*.jsonl) are read with their session.
  for (const slug of await list(paths.claudeProjects)) {
    const sub = path.join(paths.claudeProjects, slug);
    for (const f of await list(sub)) if (f.endsWith('.jsonl')) candidates.push({ tool: 'claude', file: path.join(sub, f) });
  }
  // Codex: sessions/YYYY/MM/DD/rollout-*.jsonl, plus the archived ones (flat folder).
  for (const f of await rolloutsNewestFirst(path.join(paths.codexHome, 'sessions'), Infinity)) candidates.push({ tool: 'codex', file: f });
  const archived = path.join(paths.codexHome, 'archived_sessions');
  for (const f of await list(archived)) {
    if (f.startsWith('rollout-') && f.endsWith('.jsonl')) candidates.push({ tool: 'codex', file: path.join(archived, f) });
  }

  const out: ProjectSessionFile[] = [];
  // A few files at a time: a busy machine has thousands of transcripts.
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const c = candidates[next++]!;
      const cwd = await firstCwd(c.file, c.tool);
      if (cwd && isInside(dir, cwd)) out.push({ ...c, cwd });
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * `2026-10-01` is the start of that day (local time) for `--since` and its end for `--until`;
 * anything else goes through Date.parse (ISO 8601). Returns null when the value is unreadable.
 */
export function parseBound(value: string, bound: 'since' | 'until'): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    return bound === 'since' ? new Date(y, m, d) : new Date(new Date(y, m, d + 1).getTime() - 1);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Sum of the gaps between consecutive requests, each gap capped out when it is a pause. */
export function activeTime(timestamps: string[], gapMs = ACTIVE_GAP_MS): number {
  const t = timestamps.map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = t[i]! - t[i - 1]!;
    if (gap <= gapMs) ms += gap;
  }
  return ms;
}

/**
 * The same request can appear in two transcripts: a resumed Claude session copies its history
 * (same `message.id`), a forked Codex session copies its token counts (same time, same tokens).
 */
const dedupKey = (tool: Tool, r: ModelRequest): string =>
  tool === 'claude'
    ? `claude:${r.id}`
    : `codex:${r.timestamp}:${r.usage.input}:${r.usage.output}:${r.usage.cacheRead}:${r.usage.cacheWrite5m}`;

export async function measureProject(
  dir: string,
  opts: { paths: AgentPaths; prices: PriceTable; since?: Date | null; until?: Date | null; now?: Date },
): Promise<ProjectReport> {
  const root = path.resolve(dir);
  const files = await findProjectSessions(root, opts.paths);
  const from = opts.since?.getTime() ?? -Infinity;
  const to = opts.until?.getTime() ?? Infinity;

  const seen = new Set<string>();
  const requests: PhasedRequest[] = [];
  const sessions = { claude: new Set<string>(), codex: new Set<string>() };
  for (const f of files) {
    const s = f.tool === 'claude' ? await parseClaudeSession(f.file) : await parseCodexRollout(f.file);
    for (const r of s.requests) {
      const t = Date.parse(r.timestamp);
      if (!(t >= from && t <= to)) continue;
      const key = dedupKey(f.tool, r);
      if (seen.has(key)) continue;
      seen.add(key);
      // The tool goes in `phase`, so the existing aggregation gives the per-tool split.
      requests.push({ ...r, phase: f.tool });
      sessions[f.tool].add(f.file);
    }
  }
  requests.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const summary = summarize(opts.prices, requests);
  const byTool = (['claude', 'codex'] as const).flatMap((tool) => {
    const b = summary.byPhase.find((p) => p.phase === tool);
    return b ? [{ tool, requests: b.requests, usage: b.usage, cost: b.cost }] : [];
  });
  const toolsOf = new Map<string, Set<Tool>>();
  for (const r of requests) {
    const m = normalizeModelId(r.model);
    if (!toolsOf.has(m)) toolsOf.set(m, new Set());
    toolsOf.get(m)!.add(r.phase as Tool);
  }
  const byModel = summary.byModel
    .map((b) => ({ ...b, tools: [...(toolsOf.get(b.model) ?? [])].sort() }))
    .sort((a, b) => (b.cost.value ?? -1) - (a.cost.value ?? -1) || b.requests - a.requests);
  return {
    dir: root,
    since: opts.since?.toISOString() ?? null,
    until: opts.until?.toISOString() ?? null,
    start: requests[0]?.timestamp ?? null,
    end: requests.at(-1)?.timestamp ?? null,
    activeMs: activeTime(requests.map((r) => r.timestamp)),
    sessions: { total: sessions.claude.size + sessions.codex.size, claude: sessions.claude.size, codex: sessions.codex.size },
    summary,
    byTool,
    byModel,
    prices: { ...priceTableAge(opts.prices, opts.now), maxAgeDays: opts.prices.max_age_days },
  };
}
