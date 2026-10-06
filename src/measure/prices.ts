import { readFileSync } from 'node:fs';
import { dataPath } from '../paths.js';
import type { Cost, ModelRequest } from './types.js';

/** USD per million tokens. */
interface Rates {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface ModelPrice extends Rates {
  provider: string;
  label: string;
  /** Applied to every category in fast mode (Opus). */
  fast_multiplier?: number;
  /** Rates used when a request's input (cache included) exceeds the threshold (OpenAI). */
  long_context?: Rates & { threshold_input_tokens: number };
  source: string;
  checked_at: string;
}

export interface PriceTable {
  /** Prices are never fetched at run time: this is when the table was last refreshed by hand. */
  updated_at: string;
  max_age_days: number;
  models: Record<string, ModelPrice>;
}

export interface PriceTableAge {
  updatedAt: string;
  days: number;
  stale: boolean;
}

export function priceTableAge(prices: PriceTable, now = new Date()): PriceTableAge {
  const days = Math.floor((now.getTime() - Date.parse(`${prices.updated_at}T00:00:00Z`)) / 86_400_000);
  return { updatedAt: prices.updated_at, days, stale: days > prices.max_age_days };
}

export function loadPrices(file = dataPath('prices.json')): PriceTable {
  return JSON.parse(readFileSync(file, 'utf8')) as PriceTable;
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function findPrice(prices: PriceTable, model: string): ModelPrice | undefined {
  return prices.models[normalizeModelId(model)];
}

/** API-equivalent cost of one request. A model missing from the table is never estimated. */
export function priceRequest(prices: PriceTable, req: ModelRequest): Cost {
  const p = findPrice(prices, req.model);
  if (!p) return { value: null, kind: 'unpriced' };
  const m = req.speed === 'fast' ? (p.fast_multiplier ?? 1) : 1;
  const u = req.usage;
  const contextTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const r: Rates = p.long_context && contextTokens > p.long_context.threshold_input_tokens ? p.long_context : p;
  const value =
    (u.input * r.input +
      u.output * r.output +
      u.cacheWrite5m * r.cache_write_5m +
      u.cacheWrite1h * r.cache_write_1h +
      u.cacheRead * r.cache_read) *
    m /
    1_000_000;
  return { value, kind: 'estimated' };
}
