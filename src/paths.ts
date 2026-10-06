import os from 'node:os';
import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root, from both `src/` (dev) and `dist/` (built): this file sits one level below it. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const packageRoot = (): string => root;

/** ailovebench's own folder: runs, task ideas. */
export const benchHome = (home = os.homedir()): string => process.env.AILOVEBENCH_HOME ?? path.join(home, '.ailovebench');

export const dataPath = (file: string): string => path.join(root, 'data', file);

export const catalogPath = (): string => path.join(root, 'catalog');

/** The folder used before the rename to ailovebench. */
/** Folders used under the project's former names (benchmyself, then ilovebench), newest first. */
export const legacyBenchHomes = (home = os.homedir()): string[] => [path.join(home, '.ilovebench'), path.join(home, '.benchmyself')];

/**
 * The project was renamed twice: its folder moves to `~/.ailovebench`, and every former location
 * becomes a link to it, so the absolute paths saved in older runs keep working. Returns the new
 * folder when it moved something.
 */
export function migrateLegacyHome(home = os.homedir()): string | null {
  if (process.env.AILOVEBENCH_HOME) return null;
  const target = path.join(home, '.ailovebench');
  const legacy = legacyBenchHomes(home);
  const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  const real = legacy.find((p) => existsSync(p) && !isLink(p));
  if (!real || existsSync(target)) return null;
  renameSync(real, target);
  for (const p of legacy) {
    // Links to the folder that just moved now dangle: point them at the new place.
    if (isLink(p)) unlinkSync(p);
    if (!existsSync(p)) symlinkSync(target, p);
  }
  return target;
}

/** Where runs are written: `~/.ailovebench/runs` unless AILOVEBENCH_HOME is set. */
export const runsRoot = (home = os.homedir()): string =>
  path.join(benchHome(home), 'runs');

/** Locations of the agents' local files. Overridable for tests and non-standard setups. */
export interface AgentPaths {
  claudeJson: string;
  claudeProjects: string;
  codexHome: string;
}

export function defaultAgentPaths(home = os.homedir()): AgentPaths {
  return {
    claudeJson: path.join(home, '.claude.json'),
    claudeProjects: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects'),
    codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  };
}

/** Public repository URL from package.json (`repository`), or null while the repo does not exist yet. */
export function repositoryUrl(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (!repo) return null;
    return repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
  } catch {
    return null;
  }
}
