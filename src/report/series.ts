import { priceRequest, type PriceTable } from '../measure/prices.js';
import type { ModelRequest } from '../measure/types.js';

/** One point of a job's cumulative curve, on the agent's own clock. */
export interface SeriesPoint {
  /** Agent time in seconds: phases laid end to end, QA pauses between rounds removed. */
  t: number;
  /** Cumulative API-equivalent cost (USD), null once a request could not be priced. */
  cost: number | null;
  /** Cumulative output tokens. */
  output: number;
  /** Cumulative tokens processed (input + cache read/write + output). */
  processed: number;
}

/**
 * Cumulative cost and tokens of a job's requests, placed on agent time: each request is positioned
 * inside its phase, and phases follow each other without the QA time in between.
 */
export function agentSeries(
  requests: ModelRequest[],
  phases: Array<{ name: string; startedAt: string; endedAt: string }>,
  prices: PriceTable,
): SeriesPoint[] {
  const spans = phases
    .map((p) => ({ start: Date.parse(p.startedAt), end: Date.parse(p.endedAt) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return [];
  const offsets: number[] = [];
  let acc = 0;
  for (const s of spans) {
    offsets.push(acc);
    acc += Math.max(0, s.end - s.start);
  }
  const points: SeriesPoint[] = [{ t: 0, cost: 0, output: 0, processed: 0 }];
  let cost: number | null = 0;
  let output = 0;
  let processed = 0;
  for (const r of [...requests].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const ts = Date.parse(r.timestamp);
    const i = spans.findIndex((s) => ts >= s.start && ts <= s.end + 5_000);
    if (i < 0) continue; // outside build / fix phases (e.g. a usage probe)
    const c = priceRequest(prices, r).value;
    cost = cost === null || c === null ? null : cost + c;
    const u = r.usage;
    output += u.output;
    processed += u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;
    points.push({ t: Math.round((offsets[i]! + Math.min(ts, spans[i]!.end) - spans[i]!.start) / 100) / 10, cost, output, processed });
  }
  const end = Math.round(acc / 100) / 10;
  if (points.at(-1)!.t < end) points.push({ ...points.at(-1)!, t: end });
  return points;
}
