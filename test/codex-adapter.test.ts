import { describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAdapter, parseCodexStatusScreen } from '../src/agents/codex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const screen = (name: string) => readFile(path.join(here, 'fixtures/screens', name), 'utf8');

async function fakeUserHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bm-codex-user-'));
  await cp(path.join(here, 'fixtures/user-codex-home'), dir, { recursive: true });
  return dir;
}

async function fakeJob() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bm-job-'));
  const work = path.join(root, 'work');
  await mkdir(work);
  return { root, work };
}

describe('Codex screens', () => {
  it('reads /status and converts "% left" into "% used"', async () => {
    expect(parseCodexStatusScreen(await screen('codex-status.txt'))).toEqual({
      window5hPct: 3, weekPct: 12, source: 'measured', plan: 'Plus',
    });
    expect(parseCodexStatusScreen(await screen('codex-ready.txt'))).toBeNull();
  });

  it('answers the trust question with the default choice', async () => {
    expect(codexAdapter.startupKeys(await screen('codex-trust.txt'))).toEqual(['enter']);
    expect(codexAdapter.startupKeys(await screen('codex-ready.txt'))).toBeNull();
  });

  it('keeps the benchmarked model when Codex suggests switching', async () => {
    expect(codexAdapter.startupKeys(await screen('codex-limit.txt'))).toEqual(['down', 'enter']);
  });

  it('knows when the composer is ready', async () => {
    expect(codexAdapter.isReady(await screen('codex-ready.txt'))).toBe(true);
    expect(codexAdapter.isReady(await screen('codex-trust.txt'))).toBe(false);
  });

  it('spots usage limits and API errors', async () => {
    expect(codexAdapter.screenProblem(await screen('codex-limit.txt'))).toMatchObject({ kind: 'quota' });
    expect(codexAdapter.screenProblem(await screen('codex-api-error.txt'))).toMatchObject({ kind: 'api_error' });
    expect(codexAdapter.screenProblem(await screen('codex-ready.txt'))).toBeNull();
  });

  it('builds launch arguments, trusting only the sandbox folder', () => {
    const args = codexAdapter.launchArgs({ mode: 'harness', model: 'gpt-6-astra', sessionId: 'x', work: '/tmp/w', effort: 'medium' });
    expect(args).toEqual([
      '-m', 'gpt-6-astra',
      '-c', 'model_reasoning_effort="medium"',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '-c', 'notice.hide_rate_limit_model_nudge=true',
      '-c', 'projects."/tmp/w".trust_level="trusted"',
    ]);
  });
});

describe('Codex sandbox home (mode bare)', () => {
  it('builds an isolated CODEX_HOME with auth, model cache, herdr hook and a bare config', async () => {
    const userHome = await fakeUserHome();
    const job = await fakeJob();
    const prepared = await codexAdapter.prepare({ ...job, mode: 'bare', userCodexHome: userHome });
    const home = prepared.env.CODEX_HOME!;
    expect(home).toBe(path.join(job.root, 'codex-home'));
    for (const f of ['auth.json', 'models_cache.json', 'herdr-agent-state.sh', 'hooks.json', 'config.toml']) {
      expect((await stat(path.join(home, f))).isFile()).toBe(true);
    }
    const config = await readFile(path.join(home, 'config.toml'), 'utf8');
    expect(config).toContain('include_instructions = false');
    expect(config).toContain('hide_rate_limit_model_nudge = true');
    expect(config).toContain(`[projects."${job.work}"]`);
    const hooks = JSON.parse(await readFile(path.join(home, 'hooks.json'), 'utf8'));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(path.join(home, 'herdr-agent-state.sh'));
    expect((await stat(path.join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
  });

  it('writes a refreshed token back to the user home, then deletes the copy', async () => {
    const userHome = await fakeUserHome();
    const job = await fakeJob();
    const prepared = await codexAdapter.prepare({ ...job, mode: 'bare', userCodexHome: userHome });
    const copy = path.join(prepared.env.CODEX_HOME!, 'auth.json');
    const refreshed = JSON.parse(await readFile(copy, 'utf8'));
    refreshed.last_refresh = '2026-10-01T12:00:00Z';
    refreshed.tokens.refresh_token = 'rotated';
    await writeFile(copy, JSON.stringify(refreshed));

    await prepared.cleanup();
    const user = JSON.parse(await readFile(path.join(userHome, 'auth.json'), 'utf8'));
    expect(user.tokens.refresh_token).toBe('rotated');
    await expect(stat(copy)).rejects.toThrow();
  });

  it('leaves the user token alone when the copy was not refreshed', async () => {
    const userHome = await fakeUserHome();
    const before = await readFile(path.join(userHome, 'auth.json'), 'utf8');
    const job = await fakeJob();
    const prepared = await codexAdapter.prepare({ ...job, mode: 'bare', userCodexHome: userHome });
    await prepared.cleanup();
    expect(await readFile(path.join(userHome, 'auth.json'), 'utf8')).toBe(before);
  });

  it('uses the user home untouched in mode harness', async () => {
    const userHome = await fakeUserHome();
    const prepared = await codexAdapter.prepare({ ...(await fakeJob()), mode: 'harness', userCodexHome: userHome });
    expect(prepared.env).toEqual({});
  });
});

describe('Codex transcript location', () => {
  it('finds the rollout whose cwd is the job folder, in the job home', async () => {
    const job = await fakeJob();
    const sessions = path.join(job.root, 'codex-home/sessions/2026/10/01');
    await mkdir(sessions, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', type: 'session_meta', payload: { id: 's', cwd } });
    await writeFile(path.join(sessions, 'rollout-2026-10-01T10-00-00-a.jsonl'), meta('/somewhere/else') + '\n');
    await writeFile(path.join(sessions, 'rollout-2026-10-01T10-00-01-b.jsonl'), meta(job.work) + '\n');
    const found = await codexAdapter.locateTranscript({
      work: job.work, sessionId: 'x', mode: 'bare', env: { CODEX_HOME: path.join(job.root, 'codex-home') },
      paths: { claudeJson: '/none', claudeProjects: '/none', codexHome: '/none' },
    });
    expect(found).toBe(path.join(sessions, 'rollout-2026-10-01T10-00-01-b.jsonl'));
  });
});

describe('Codex /status with several blocks on screen', () => {
  it('reads the most recent block', async () => {
    const older = (await screen('codex-status.txt')).replace('97% left', '100% left').replace('88% left', '100% left');
    const both = older + '\n› Build…\n• done\n' + (await screen('codex-status.txt'));
    expect(parseCodexStatusScreen(both)).toMatchObject({ window5hPct: 3, weekPct: 12 });
  });
});
