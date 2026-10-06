import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.js';
import { parseCodexRollout } from '../measure/transcripts/codex.js';

export interface Plan {
  agent: 'claude' | 'codex' | 'cursor';
  /** Identifier as the CLI exposes it, null when unreadable. */
  raw: string | null;
  label: string;
  source: 'measured' | 'unknown';
}

interface PlansFile {
  claude: { tiers: Record<string, { label: string }> };
  codex: { tiers: Record<string, { label: string }> };
}

const plans = (): PlansFile => JSON.parse(readFileSync(dataPath('plans.json'), 'utf8'));

function toPlan(agent: Plan['agent'], raw: string | null | undefined): Plan {
  if (!raw) return { agent, raw: null, label: 'unknown', source: 'unknown' };
  const tiers = agent === 'cursor' ? {} : plans()[agent].tiers;
  return { agent, raw, label: tiers[raw]?.label ?? (agent === 'cursor' ? `Cursor ${raw}` : raw), source: 'measured' };
}

/** Subscription tier as `cursor-agent about` prints it. */
export async function detectCursorPlan(): Promise<Plan> {
  const { readCursorPlan } = await import('../agents/cursor.js');
  return toPlan('cursor', await readCursorPlan());
}

/** Reads only `oauthAccount.organizationRateLimitTier`; nothing else of the account is kept. */
export async function detectClaudePlan(claudeJson: string): Promise<Plan> {
  try {
    const json = JSON.parse(await readFile(claudeJson, 'utf8'));
    return toPlan('claude', json?.oauthAccount?.organizationRateLimitTier);
  } catch {
    return toPlan('claude', null);
  }
}

/**
 * Plan type of the most recent rollout that reports rate limits. Older rollouts are not used as a
 * fallback: they may come from another account logged in earlier.
 */
export async function detectCodexPlan(codexHome: string): Promise<Plan> {
  for (const file of await rolloutsNewestFirst(path.join(codexHome, 'sessions'))) {
    const { rateLimits } = await parseCodexRollout(file);
    if (rateLimits.length) return toPlan('codex', rateLimits.findLast((r) => r.planType)?.planType);
  }
  return toPlan('codex', null);
}

/** Rollouts sorted newest first (paths are `YYYY/MM/DD/rollout-<ISO time>-<id>.jsonl`). */
export async function rolloutsNewestFirst(sessionsDir: string, limit = 20): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort().reverse();
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e);
      if (depth < 3) await walk(full, depth + 1);
      else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(sessionsDir, 0);
  return out;
}
