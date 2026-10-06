import { access, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchHome, packageRoot } from '../paths.js';

/**
 * Agent isolation on macOS: each agent's shell runs under `sandbox-exec`, which forbids reading
 * ailovebench's own folders (other jobs and runs, the user's task ideas) and the installed package
 * (catalog with hidden tests, checks' source). Only the agent's own job folder stays open there.
 */
export type Isolation = 'sandbox' | 'none';

/** Real paths: the sandbox matches resolved paths, so a symlinked install must be denied by its target. */
const real = (p: string) => realpath(p).catch(() => path.resolve(p));

const q = (p: string) => JSON.stringify(p);

/** Folders above `p`, up to the filesystem root. */
const ancestors = (p: string) => {
  const out: string[] = [];
  for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.push(d);
  return out;
};

/**
 * SBPL profile: the last matching rule wins, so the job's own folder is re-allowed after the
 * denials. Its parent folders can be examined (stat), not listed: Claude Code vets every component
 * of a path before reading a settings file.
 */
export function jailProfile(deny: string[], allow: string[]): string {
  const parents = [...new Set(allow.flatMap(ancestors))].filter((a) => deny.some((d) => a === d || a.startsWith(`${d}/`)));
  return [
    '(version 1)',
    '(allow default)',
    ...deny.map((p) => `(deny file-read* file-write* (subpath ${q(p)}))`),
    ...parents.map((p) => `(allow file-read-metadata (literal ${q(p)}))`),
    ...allow.map((p) => `(allow file-read* file-write* (subpath ${q(p)}))`),
    '',
  ].join('\n');
}

export async function jailAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin' || process.env.AILOVEBENCH_NO_SANDBOX === '1') return false;
  return access('/usr/bin/sandbox-exec').then(() => true, () => false);
}

/** Writes `<root>/sandbox.sb` and returns its path, plus a folder the agent must not be able to read. */
export async function writeJailProfile(root: string): Promise<{ profile: string; probe: string }> {
  const home = await real(benchHome());
  const deny = [...new Set([home, await real(packageRoot())])];
  const profile = path.join(root, 'sandbox.sb');
  await writeFile(profile, jailProfile(deny, [await real(root)]));
  return { profile, probe: home };
}
