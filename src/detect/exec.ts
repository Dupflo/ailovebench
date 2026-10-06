import { execFile } from 'node:child_process';

/** Runs a command and returns its trimmed stdout, or null if it fails or is missing. */
export function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** First version-looking token of `<bin> --version`, e.g. `codex-cli 0.159.3` → `0.159.3`. */
export async function commandVersion(bin: string): Promise<string | null> {
  const out = await run(bin, ['--version']);
  if (out === null) return null;
  return out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? out.split('\n')[0] ?? null;
}
