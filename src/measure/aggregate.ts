import { priceRequest, normalizeModelId, type PriceTable } from './prices.js';
import { addUsage, emptyUsage, type Cost, type ModelRequest, type TokenUsage } from './types.js';

/** The instant the runner sent the prompt that starts a phase (build, fix-1…). */
export interface PhaseMark {
  name: string;
  at: string;
}

export interface PhasedRequest extends ModelRequest {
  phase: string;
}

/** Each request belongs to the last phase started before it; earlier requests go to `pre`. */
export function assignPhases(requests: ModelRequest[], marks: PhaseMark[]): PhasedRequest[] {
  const sorted = [...marks].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return requests.map((r) => {
    const t = Date.parse(r.timestamp);
    let phase = marks.length ? 'pre' : 'all';
    for (const m of sorted) if (Date.parse(m.at) <= t) phase = m.name;
    return { ...r, phase };
  });
}

export interface Bucket {
  requests: number;
  usage: TokenUsage;
  cost: Cost;
}

export interface Summary {
  total: Bucket;
  byPhase: Array<Bucket & { phase: string }>;
  byModel: Array<Bucket & { model: string }>;
  unpricedModels: string[];
}

export function summarize(prices: PriceTable, requests: PhasedRequest[]): Summary {
  const unpriced = new Set<string>();
  const total = emptyBucket();
  const phases = new Map<string, Bucket>();
  const models = new Map<string, Bucket>();

  for (const r of requests) {
    const cost = priceRequest(prices, r);
    const model = normalizeModelId(r.model);
    if (cost.kind === 'unpriced') unpriced.add(model);
    for (const b of [total, upsert(phases, r.phase), upsert(models, model)]) add(b, r.usage, cost);
  }

  return {
    total,
    byPhase: [...phases].map(([phase, b]) => ({ phase, ...b })),
    byModel: [...models].map(([model, b]) => ({ model, ...b })),
    unpricedModels: [...unpriced].sort(),
  };
}

const emptyBucket = (): Bucket => ({ requests: 0, usage: emptyUsage(), cost: { value: null, kind: 'unpriced' } });

function upsert(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) map.set(key, (b = emptyBucket()));
  return b;
}

function add(b: Bucket, usage: TokenUsage, cost: Cost): void {
  const first = b.requests === 0;
  b.requests += 1;
  b.usage = addUsage(b.usage, usage);
  if (cost.value !== null) b.cost.value = (b.cost.value ?? 0) + cost.value;
  b.cost.kind = first ? cost.kind : b.cost.kind === cost.kind ? cost.kind : 'partial';
}
