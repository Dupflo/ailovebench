import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPaths } from '../paths.js';
import { rolloutsNewestFirst } from '../detect/subscriptions.js';

export interface LocatedSession {
  agent: 'claude' | 'codex' | 'cursor';
  file: string;
}

const exists = (f: string) => access(f).then(() => true, () => false);

/** Accepts a transcript path, a Claude session id, or a Codex session id. */
export async function locateSession(ref: string, paths: AgentPaths): Promise<LocatedSession | null> {
  if (await exists(ref)) {
    // Cursor phases are written by the bench as <job>/phases/<phase>.jsonl.
    if (path.basename(path.dirname(ref)) === 'phases') return { agent: 'cursor', file: ref };
    return { agent: path.basename(ref).startsWith('rollout-') ? 'codex' : 'claude', file: ref };
  }

  let projects: string[] = [];
  try {
    projects = await readdir(paths.claudeProjects);
  } catch {
    // No Claude Code data on this machine.
  }
  for (const p of projects) {
    const file = path.join(paths.claudeProjects, p, `${ref}.jsonl`);
    if (await exists(file)) return { agent: 'claude', file };
  }

  const rollout = (await rolloutsNewestFirst(path.join(paths.codexHome, 'sessions'), 5000)).find((f) =>
    path.basename(f).includes(ref),
  );
  return rollout ? { agent: 'codex', file: rollout } : null;
}
