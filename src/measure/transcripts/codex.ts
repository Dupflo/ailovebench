import { readJsonl, num } from '../jsonl.js';
import { addOnce, type ModelRequest, type ParsedSession } from '../types.js';

export interface RateLimitSnapshot {
  timestamp: string;
  planType: string | null;
  /** % used of the 5-hour window, null when the plan has none. */
  window5hPct: number | null;
  /** % used of the weekly window, null when the plan has none. */
  weekPct: number | null;
}

export interface CodexSession extends ParsedSession {
  cliVersion: string | null;
  rateLimits: RateLimitSnapshot[];
}

/**
 * Parses a Codex rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * `token_count` events carry a cumulative `total_token_usage`; each request is the delta from the
 * previous total. Codex counts cached input inside `input_tokens` and reasoning inside
 * `output_tokens`, so cached input is moved to `cacheRead` to avoid billing it twice.
 * Recent rollouts also carry `cache_write_input_tokens`, taken out of `input_tokens` the same way
 * and billed as a cache write (OpenAI has a single cache-write rate: the 5-minute one is used).
 * Up to 0.159 it is written but always 0.
 */
export async function parseCodexRollout(file: string): Promise<CodexSession> {
  const session: CodexSession = {
    agent: 'codex', sessionId: null, cwd: null, startedAt: null, endedAt: null,
    requests: [], messages: [], harness: { skills: [], mcp: [] }, cliVersion: null, rateLimits: [],
  };
  let model = 'unknown';
  let prev: Totals | null = null;

  for await (const line of readJsonl(file)) {
    const p = line.payload ?? {};
    if (line.timestamp) session.startedAt ??= line.timestamp;

    if (line.type === 'session_meta') {
      session.sessionId = p.id ?? null;
      session.cwd = p.cwd ?? null;
      session.cliVersion = p.cli_version ?? null;
    } else if (line.type === 'turn_context' && p.model) {
      model = p.model;
    } else if (line.type === 'response_item' && p.type === 'function_call') {
      // Codex uses a skill by reading its SKILL.md; MCP tools are named mcp__<server>__<tool>.
      for (const m of String(p.arguments ?? '').matchAll(/skills\/([^/"'\s]+)\/SKILL\.md/g)) addOnce(session.harness.skills, m[1]);
      if (typeof p.name === 'string' && p.name.startsWith('mcp__')) addOnce(session.harness.mcp, p.name.split('__')[1]);
    } else if (line.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content ?? []).map((c: any) => c?.text ?? '').join('').trim();
      if (text) session.messages.push({ timestamp: line.timestamp, text });
    } else if (p.type === 'token_count') {
      if (p.rate_limits) session.rateLimits.push(snapshot(line.timestamp, p.rate_limits));
      if (!p.info?.total_token_usage) continue;
      const total = totals(p.info.total_token_usage);
      // A total lower than the previous one means the counter was reset: start a new baseline.
      const base: Totals = prev && total.input >= prev.input ? prev : ZERO;
      prev = total;
      const d = diff(total, base);
      if (d.input === 0 && d.output === 0) continue;
      session.requests.push({
        id: `${session.sessionId ?? 'codex'}#${session.requests.length + 1}`,
        model,
        timestamp: line.timestamp,
        speed: 'standard',
        sidechain: false,
        usage: {
          input: d.input - d.cached - d.cacheWrite,
          output: d.output,
          cacheWrite5m: d.cacheWrite,
          cacheWrite1h: 0,
          cacheRead: d.cached,
          reasoning: d.reasoning,
        },
      });
      session.endedAt = line.timestamp;
    }
  }
  return session;
}

interface Totals { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }
const ZERO: Totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

const totals = (t: Record<string, unknown>): Totals => ({
  input: num(t.input_tokens),
  cached: num(t.cached_input_tokens),
  cacheWrite: num(t.cache_write_input_tokens),
  output: num(t.output_tokens),
  reasoning: num(t.reasoning_output_tokens),
});

const diff = (a: Totals, b: Totals): Totals => ({
  input: a.input - b.input,
  cached: a.cached - b.cached,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  output: a.output - b.output,
  reasoning: a.reasoning - b.reasoning,
});

function snapshot(timestamp: string, rl: Record<string, any>): RateLimitSnapshot {
  const pct = (w: any): number | null => (typeof w?.used_percent === 'number' ? w.used_percent : null);
  return {
    timestamp,
    planType: rl.plan_type ?? null,
    window5hPct: pct(rl.primary),
    weekPct: pct(rl.secondary),
  };
}
