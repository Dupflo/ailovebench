import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeSession } from '../src/measure/transcripts/claude.js';
import { parseCodexRollout } from '../src/measure/transcripts/codex.js';
import { loadPrices, priceRequest, normalizeModelId } from '../src/measure/prices.js';
import { assignPhases, summarize } from '../src/measure/aggregate.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const claudeSession = path.join(fixtures, 'claude/proj/sess-1.jsonl');
const codexRollout = path.join(
  fixtures,
  'codex-home/sessions/2026/10/01/rollout-2026-10-01T10-00-00-sess-codex-1.jsonl',
);

describe('Claude transcript', () => {
  it('dedups requests by message.id, keeping the last line, and skips synthetic messages', async () => {
    const s = await parseClaudeSession(claudeSession);
    const main = s.requests.filter((r) => !r.sidechain);
    expect(main.map((r) => r.id)).toEqual(['msg_1', 'msg_2']);
    expect(main[0]!.usage).toEqual({
      input: 10, output: 100, cacheWrite5m: 0, cacheWrite1h: 1000, cacheRead: 5000, reasoning: 0,
    });
    expect(main[1]!.speed).toBe('fast');
  });

  it('includes subagent transcripts, flagged as sidechain', async () => {
    const s = await parseClaudeSession(claudeSession);
    const sub = s.requests.filter((r) => r.sidechain);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('returns requests in time order with session metadata', async () => {
    const s = await parseClaudeSession(claudeSession);
    expect(s.requests.map((r) => r.id)).toEqual(['msg_1', 'msg_3', 'msg_2']);
    expect(s.sessionId).toBe('sess-1');
    expect(s.cwd).toBe('/tmp/bench/work');
    expect(s.startedAt).toBe('2026-10-01T10:00:00.000Z');
    expect(s.endedAt).toBe('2026-10-01T10:01:00.000Z');
  });
});

describe('Codex rollout', () => {
  it('turns cumulative totals into per-request deltas and bills cached input separately', async () => {
    const s = await parseCodexRollout(codexRollout);
    expect(s.sessionId).toBe('sess-codex-1');
    expect(s.cliVersion).toBe('0.159.3');
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]!.usage).toEqual({
      input: 200, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 800, reasoning: 10,
    });
    expect(s.requests[1]!.usage).toEqual({
      input: 300, output: 70, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1200, reasoning: 20,
    });
    expect(s.requests[1]!.model).toBe('gpt-test-unpriced');
  });

  it('keeps rate-limit snapshots and tolerates missing windows', async () => {
    const s = await parseCodexRollout(codexRollout);
    expect(s.rateLimits).toHaveLength(2);
    expect(s.rateLimits[0]).toMatchObject({ planType: 'pro', window5hPct: 3, weekPct: 12 });
    expect(s.rateLimits[1]).toMatchObject({ planType: 'pro', window5hPct: 4, weekPct: null });
  });
});

describe('prices', () => {
  const prices = loadPrices();

  it('normalizes dated model ids', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('prices every token category, with the fast multiplier', async () => {
    const s = await parseClaudeSession(claudeSession);
    const [msg1, msg3, msg2] = s.requests;
    expect(priceRequest(prices, msg1!).value).toBeCloseTo(0.01104, 8);
    expect(priceRequest(prices, msg2!).value).toBeCloseTo(0.007616, 8);
    expect(priceRequest(prices, msg3!).value).toBeCloseTo(0.0002, 8);
    expect(priceRequest(prices, msg1!).kind).toBe('estimated');
  });

  it('never estimates a model missing from the table', async () => {
    const s = await parseCodexRollout(codexRollout);
    const cost = priceRequest(prices, s.requests[0]!);
    expect(cost).toEqual({ value: null, kind: 'unpriced' });
  });
});

describe('aggregate', () => {
  it('assigns requests to phases from prompt timestamps', async () => {
    const s = await parseClaudeSession(claudeSession);
    const phased = assignPhases(s.requests, [
      { name: 'build', at: '2026-10-01T10:00:00.000Z' },
      { name: 'fix-1', at: '2026-10-01T10:00:45.000Z' },
    ]);
    expect(phased.map((r) => r.phase)).toEqual(['build', 'build', 'fix-1']);
  });

  it('puts requests before the first mark in "pre"', async () => {
    const s = await parseClaudeSession(claudeSession);
    const phased = assignPhases(s.requests, [{ name: 'build', at: '2026-10-01T10:00:20.000Z' }]);
    expect(phased.map((r) => r.phase)).toEqual(['pre', 'build', 'build']);
  });

  it('sums tokens and cost per phase and in total', async () => {
    const s = await parseClaudeSession(claudeSession);
    const summary = summarize(loadPrices(), assignPhases(s.requests, []));
    expect(summary.total.requests).toBe(3);
    expect(summary.total.usage.output).toBe(170);
    expect(summary.total.cost.value).toBeCloseTo(0.018856, 8);
    expect(summary.total.cost.kind).toBe('estimated');
    expect(summary.byModel.map((m) => m.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
  });

  it('flags a total as partially unpriced when one model has no price', async () => {
    const claude = await parseClaudeSession(claudeSession);
    const codex = await parseCodexRollout(codexRollout);
    const summary = summarize(loadPrices(), assignPhases([...claude.requests, ...codex.requests], []));
    expect(summary.total.cost.kind).toBe('partial');
    expect(summary.total.cost.value).toBeCloseTo(0.018856, 8);
    expect(summary.unpricedModels).toEqual(['gpt-test-unpriced']);
  });
});

describe('price table freshness and long context', () => {
  it('exposes when the table was last updated, and flags it as stale after max_age_days', async () => {
    const { priceTableAge } = await import('../src/measure/prices.js');
    const prices = loadPrices();
    expect(prices.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const fresh = priceTableAge(prices, new Date(`${prices.updated_at}T12:00:00Z`));
    expect(fresh).toMatchObject({ updatedAt: prices.updated_at, days: 0, stale: false });
    const later = new Date(Date.parse(`${prices.updated_at}T12:00:00Z`) + (prices.max_age_days + 1) * 86_400_000);
    expect(priceTableAge(prices, later).stale).toBe(true);
  });

  it('prices OpenAI models, switching to long-context rates above the threshold', () => {
    const prices = loadPrices();
    const req = (input: number, cacheRead: number) => ({
      id: 'x', model: 'gpt-6-astra', timestamp: '2026-10-01T10:00:00Z', speed: 'standard' as const, sidechain: false,
      usage: { input, output: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead, reasoning: 0 },
    });
    // short: 10 000 × 10 + 100 000 × 1 + 1 000 × 50 = 250 000 → 0,25 $
    expect(priceRequest(prices, req(10_000, 100_000)).value).toBeCloseTo(0.25, 8);
    // long (> 272k input incl. cache): 10 000 × 20 + 300 000 × 2 + 1 000 × 75 = 875 000 → 0,875 $
    expect(priceRequest(prices, req(10_000, 300_000)).value).toBeCloseTo(0.875, 8);
  });
});

describe('phase summaries', async () => {
  const { phaseSummaries } = await import('../src/measure/summaries.js');
  it('keeps the last real message of each phase, skipping a bare end marker', () => {
    const messages = [
      { timestamp: '2026-10-01T10:00:10Z', text: 'Je commence.' },
      { timestamp: '2026-10-01T10:05:00Z', text: 'Page créée, build OK, testée en 375 et 1440 px.' },
      { timestamp: '2026-10-01T10:05:01Z', text: 'TERMINÉ' },
      { timestamp: '2026-10-01T10:10:00Z', text: 'FAQ corrigée : boutons avec aria-expanded.\n\nTERMINÉ' },
    ];
    expect(phaseSummaries(messages, [
      { name: 'build', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:05:02Z' },
      { name: 'fix-1', startedAt: '2026-10-01T10:09:00Z', endedAt: '2026-10-01T10:10:01Z' },
    ])).toEqual({ build: 'Page créée, build OK, testée en 375 et 1440 px.', 'fix-1': 'FAQ corrigée : boutons avec aria-expanded.' });
  });
});

describe('agent-time series', async () => {
  const { agentSeries } = await import('../src/report/series.js');
  const req = (id: string, timestamp: string, output: number) => ({
    id, model: 'claude-sonnet-5-5', timestamp, speed: 'standard' as const, sidechain: false,
    usage: { input: 0, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, reasoning: 0 },
  });
  it('lays phases end to end on agent time, skipping the QA pause between them', () => {
    const points = agentSeries(
      [req('a', '2026-10-01T10:00:30Z', 1000), req('b', '2026-10-01T10:20:10Z', 500)],
      [
        { name: 'build', startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:01:00Z' },
        { name: 'fix-1', startedAt: '2026-10-01T10:20:00Z', endedAt: '2026-10-01T10:20:30Z' },
      ],
      loadPrices(),
    );
    expect(points.map((p) => p.t)).toEqual([0, 30, 70, 90]);
    expect(points.map((p) => p.output)).toEqual([0, 1000, 1500, 1500]);
    expect(points[2]!.cost).toBeCloseTo(0.015, 8); // 1 500 × 10 $ / M
  });
});
