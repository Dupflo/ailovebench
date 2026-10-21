import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { commandVersion } from './exec.js';
import { tr } from '../i18n.js';

/** herdr's official installer: no sudo, checks the binary's SHA-256, installs to ~/.local/bin. */
export const HERDR_INSTALL_CMD = 'curl -fsSL https://herdr.dev/install.sh | sh';

/** Where the installer puts herdr (HERDR_INSTALL_DIR overrides it, as in the installer). */
export function herdrInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_INSTALL_DIR || path.join(os.homedir(), '.local', 'bin');
}

/** Puts `dir` first in PATH for this process and the agents it starts. False if already there. */
export function addToPath(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const parts = (env.PATH ?? '').split(path.delimiter);
  if (parts.includes(dir)) return false;
  env.PATH = [dir, ...parts.filter(Boolean)].join(path.delimiter);
  return true;
}

/** herdr reachable on PATH, or installed by its installer in a folder the shell doesn't know yet. */
export async function findHerdr(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const onPath = await commandVersion('herdr');
  if (onPath) return onPath;
  const dir = herdrInstallDir(env);
  const local = await commandVersion(path.join(dir, 'herdr'));
  if (local) addToPath(dir, env);
  return local;
}

function runInstaller(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', HERDR_INSTALL_CMD], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Makes sure herdr is there before a bench. When it is missing, offers to run the official
 * installer (`ask` returns the answer; non-interactive callers pass `async () => false`).
 */
export async function ensureHerdr(ask: (message: string) => Promise<boolean>): Promise<boolean> {
  if (await findHerdr()) return true;
  const manual = tr(`Pour l'installer toi-même : ${HERDR_INSTALL_CMD}`, `To install it yourself: ${HERDR_INSTALL_CMD}`);
  if (process.platform === 'win32') {
    console.log(tr("herdr est introuvable, et il ne fonctionne pas sous Windows : lance ailovebench dans WSL.", 'herdr not found, and it does not run on Windows: run ailovebench inside WSL.'));
    return false;
  }
  const yes = await ask(tr(
    "herdr est introuvable : c'est le multiplexeur qui pilote les agents, une fenêtre de terminal par IA. L'installer maintenant (script officiel de herdr.dev, dans ~/.local/bin, sans mot de passe) ?",
    'herdr not found: it is the multiplexer that drives the agents, one terminal pane per AI. Install it now (official herdr.dev script, into ~/.local/bin, no password)?',
  ));
  if (!yes) {
    console.log(manual);
    return false;
  }
  if ((await runInstaller()) !== 0 || !(await findHerdr())) {
    console.log(tr("L'installation de herdr a échoué.", 'herdr installation failed.'));
    console.log(manual);
    return false;
  }
  console.log(tr(`herdr ${await findHerdr()} installé.`, `herdr ${await findHerdr()} installed.`));
  return true;
}
