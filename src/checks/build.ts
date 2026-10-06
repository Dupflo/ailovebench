import { exec } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { CheckResult, Deliverable } from './types.js';

export interface CommandOutcome {
  ok: boolean;
  output: string;
  durationMs: number;
}

/** Runs a shell command in the job folder. The full output is kept; callers truncate for display. */
export function runCommand(command: string, cwd: string, timeoutMs = 10 * 60_000): Promise<CommandOutcome> {
  const start = Date.now();
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim(), durationMs: Date.now() - start });
    });
  });
}

/** The deliverable contract: install, build, and the entry file must exist in the static folder. */
export async function runBuild(work: string, d: Deliverable): Promise<CheckResult> {
  const label = 'Build';
  const install = await runCommand(d.install, work);
  if (!install.ok) return { id: 'build', label, status: 'fail', detail: `« ${d.install} » a échoué\n${install.output.slice(-3000)}`, detailEn: `"${d.install}" failed\n${install.output.slice(-3000)}` };
  const build = await runCommand(d.build, work);
  if (!build.ok) return { id: 'build', label, status: 'fail', detail: `« ${d.build} » a échoué\n${build.output.slice(-3000)}`, detailEn: `"${d.build}" failed\n${build.output.slice(-3000)}` };
  const entry = path.join(work, d.static_dir, d.entry);
  try {
    await access(entry);
  } catch {
    return { id: 'build', label, status: 'fail', detail: `${d.static_dir}/${d.entry} absent après le build`, detailEn: `${d.static_dir}/${d.entry} missing after the build` };
  }
  return { id: 'build', label, status: 'pass', value: install.durationMs + build.durationMs, detail: 'install + build (ms)' };
}
