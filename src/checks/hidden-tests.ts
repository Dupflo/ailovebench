import { cp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runCommand } from './build.js';

export interface TestRun {
  passed: number;
  failed: number;
  failing: FailingTest[];
  output: string;
}

export interface FailingTest {
  name: string;
  message: string;
}

/**
 * `not ok 2 - name` entries of TAP output, reduced to what a client bug report would say:
 * « attendu 0, obtenu -200 », or the first line of the error. File paths and stacks are dropped
 * so nothing about the hidden test files reaches the agent.
 */
export function parseFailingTests(output: string): FailingTest[] {
  const lines = output.split('\n');
  const out: FailingTest[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*not ok \d+ - (.+)$/);
    if (!m) return;
    let expected: string | undefined;
    let actual: string | undefined;
    let firstError: string | undefined;
    for (let k = i + 1; k < lines.length && !/^\s*\.\.\.\s*$/.test(lines[k]!) && !/^\s*(not )?ok \d+/.test(lines[k]!); k++) {
      const l = lines[k]!;
      const kv = l.match(/^\s{2}(expected|actual): (.*)$/);
      if (kv) {
        if (kv[1] === 'expected') expected = kv[2]!.trim();
        else actual = kv[2]!.trim();
      }
      if (/^\s{2}error: \|-/.test(l)) firstError = lines[k + 1]?.trim();
      else if (!firstError && /^\s{2}error: /.test(l)) firstError = l.replace(/^\s{2}error: /, '').trim();
    }
    const message = expected !== undefined && actual !== undefined ? `attendu ${expected}, obtenu ${actual}` : (firstError ?? '');
    out.push({ name: m[1]!.trim(), message: message.replace(/\/[^\s'"]+/g, '…') });
  });
  return out;
}

/** Reads `node --test` totals, TAP (`# pass 12`) or spec reporter (`ℹ pass 12`). */
export function parseNodeTestOutput(output: string): { passed: number; failed: number } | null {
  const pass = output.match(/^(?:#|ℹ) pass (\d+)/m);
  const fail = output.match(/^(?:#|ℹ) fail (\d+)/m);
  if (!pass || !fail) return null;
  return { passed: Number(pass[1]), failed: Number(fail[1]) };
}

/**
 * Copies the task's hidden tests into the job folder (only now, after the build: the agent never
 * saw them) and runs them.
 */
export async function runHiddenTests(work: string, hiddenDir: string, command: string): Promise<TestRun> {
  const entries = (await readdir(hiddenDir)).filter((e) => e !== 'scenarios.mjs');
  for (const e of entries) await cp(path.join(hiddenDir, e), path.join(work, e), { recursive: true });
  try {
    const r = await runCommand(command, work, 5 * 60_000);
    const counts = parseNodeTestOutput(r.output) ?? { passed: 0, failed: 0 };
    return { ...counts, failing: parseFailingTests(r.output), output: r.output };
  } finally {
    // The agent may get a fix round in this same folder: it must never see the hidden tests.
    for (const e of entries) await rm(path.join(work, e), { recursive: true, force: true });
  }
}

export async function sha256(file: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Files the agent was told not to touch (e.g. the visible tests), compared to the starter. */
export async function modifiedFiles(starterDir: string, work: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if ((await sha256(path.join(starterDir, f))) !== (await sha256(path.join(work, f)))) out.push(f);
  }
  return out;
}
