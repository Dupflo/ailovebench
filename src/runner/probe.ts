import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, QuotaReading } from '../agents/types.js';
import type { Herdr } from '../herdr/client.js';
import type { AgentPaths } from '../paths.js';
import { AgentSession } from './session.js';

/** Cheapest model per agent: the probe sends no prompt, the model is only needed to start the CLI. */
const PROBE_MODEL: Record<string, string> = { claude: 'claude-haiku-4-5', codex: 'gpt-6-luna' };

/**
 * Starts the agent in a throwaway folder just long enough to read its usage screen. Returns the
 * reading (5-hour and weekly % used, plan when shown) or null when it could not be read.
 */
export async function probeQuota(adapter: AgentAdapter, herdr: Herdr, agentPaths: AgentPaths, runsRoot: string): Promise<QuotaReading | null> {
  const root = path.join(path.dirname(runsRoot), 'probe', `${adapter.kind}-${Date.now()}`);
  const cwd = path.join(root, 'work');
  await mkdir(cwd, { recursive: true });
  let session: AgentSession | null = null;
  try {
    session = await AgentSession.open({
      herdr, adapter, agentPaths, root, cwd, mode: 'bare', model: PROBE_MODEL[adapter.kind] ?? 'default', effort: 'low',
      label: `bm quota ${adapter.kind}`,
    });
    return await session.quota();
  } catch {
    return null;
  } finally {
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
}
