import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAdapter, parseClaudeUsageScreen } from '../src/agents/claude.js';
import { Herdr, HerdrError } from '../src/herdr/client.js';
import { loadTask } from '../src/catalog/load.js';
import { prepareSandbox, jobId } from '../src/runner/sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const screen = (name: string) => readFile(path.join(here, 'fixtures/screens', name), 'utf8');

describe('Claude screens', () => {
  it('reads the /usage screen', async () => {
    expect(parseClaudeUsageScreen(await screen('claude-usage.txt'))).toEqual({
      window5hPct: 40, weekPct: 62, source: 'measured',
    });
  });

  it('returns null when the usage screen is not displayed', async () => {
    expect(parseClaudeUsageScreen(await screen('claude-ready.txt'))).toBeNull();
  });

  it('answers the folder trust question, and only that', async () => {
    expect(claudeAdapter.startupKeys(await screen('claude-trust.txt'))).toEqual(['down', 'enter']);
    expect(claudeAdapter.startupKeys(await screen('claude-ready.txt'))).toBeNull();
  });

  it('knows when the input prompt is ready', async () => {
    expect(claudeAdapter.isReady(await screen('claude-ready.txt'))).toBe(true);
    expect(claudeAdapter.isReady(await screen('claude-trust.txt'))).toBe(false);
  });

  it('spots API errors and usage limits that herdr reports as "done"', async () => {
    expect(claudeAdapter.screenProblem(await screen('claude-api-error.txt'))).toMatchObject({ kind: 'api_error' });
    expect(claudeAdapter.screenProblem(await screen('claude-limit.txt'))).toMatchObject({ kind: 'quota' });
    expect(claudeAdapter.screenProblem(await screen('claude-ready.txt'))).toBeNull();
  });

  it('builds launch arguments for each mode', () => {
    const base = { model: 'sonnet', sessionId: 'abc', work: '/tmp/w', effort: 'medium' as const };
    expect(claudeAdapter.launchArgs({ ...base, mode: 'bare' })).toEqual([
      '--safe-mode', '--dangerously-skip-permissions', '--session-id', 'abc', '--model', 'sonnet', '--effort', 'medium',
    ]);
    expect(claudeAdapter.launchArgs({ ...base, mode: 'harness' })).toEqual([
      '--dangerously-skip-permissions', '--session-id', 'abc', '--model', 'sonnet', '--effort', 'medium',
    ]);
  });
});

describe('herdr client', () => {
  it('creates a workspace and returns its root pane', async () => {
    const calls: string[][] = [];
    const herdr = new Herdr(async (args) => {
      calls.push(args);
      return JSON.stringify({ result: { root_pane: { pane_id: 'w9:p1' }, workspace: { workspace_id: 'w9' } } });
    });
    expect(await herdr.workspaceCreate('/tmp/x', 'bm-test')).toEqual({ workspaceId: 'w9', paneId: 'w9:p1' });
    expect(calls[0]).toEqual(['workspace', 'create', '--cwd', '/tmp/x', '--label', 'bm-test', '--no-focus']);
  });

  it('waits for a prompt to settle and reports the final status', async () => {
    const herdr = new Herdr(async (args) => {
      expect(args.slice(0, 3)).toEqual(['agent', 'prompt', 'job1']);
      expect(args).toContain('--wait');
      return JSON.stringify({ result: { type: 'agent_prompted', agent: { agent_status: 'done' } } });
    });
    expect(await herdr.promptAndWait('job1', 'hello', 60_000)).toEqual({ status: 'done' });
  });

  it('reads the visible screen along with recent output, which herdr 0.8 can leave empty', async () => {
    const herdr = new Herdr(async (args) => (args.at(-1) === 'recent' ? '' : 'BM_JAIL_x_closed'));
    expect(await herdr.paneRead('w9:p1', 'recent')).toContain('BM_JAIL_x_closed');
  });

  it('waits for markers on the visible screen', async () => {
    const calls: string[][] = [];
    const herdr = new Herdr(async (args) => { calls.push(args); return ''; });
    expect(await herdr.paneWaitOutput('w9:p1', 'BM_', 1000)).toBe(true);
    expect(calls[0]).toContain('visible');
  });

  it('turns a stalled prompt into a status instead of throwing', async () => {
    const herdr = new Herdr(async () => {
      throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ error: { code: 'agent_prompt_stalled' } }) });
    });
    expect(await herdr.promptAndWait('job1', 'hello', 60_000)).toEqual({ status: 'stalled' });
  });
});

describe('catalog', () => {
  it('loads a task with its prompt', async () => {
    const task = await loadTask('web-01');
    expect(task.id).toBe('web-01');
    expect(task.category).toBeTruthy();
    expect(task.timeoutMin).toBeGreaterThan(0);
    expect(task.prompt.length).toBeGreaterThan(100);
  });

  it('rejects an unknown task', async () => {
    await expect(loadTask('nope-99')).rejects.toThrow(/nope-99/);
  });
});

describe('sandbox', () => {
  it('creates an isolated work folder with its own git repo', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'bm-'));
    const job = { runId: 'r1', taskId: 'web-01', model: 'claude-sonnet-5-5', mode: 'bare' as const };
    const dirs = await prepareSandbox(root, job);
    expect(jobId(job)).toBe('web-01__claude-sonnet-5-5__bare');
    expect(dirs.work).toBe(path.join(root, 'r1', 'web-01__claude-sonnet-5-5__bare', 'work'));
    expect((await stat(path.join(dirs.work, '.git'))).isDirectory()).toBe(true);
  });
});

describe('runJob', () => {
  // The job module pulls in the browser checks: load it once, outside the per-test timeout.
  beforeAll(() => import('../src/runner/job.js'), 180_000);

  const fakeHerdr = (screens: { initial: string[]; usage: string; final: string }, outcome = 'done') => {
    const calls: string[] = [];
    let readCount = 0;
    let usageOpen = false;
    const herdr = {
      workspaceCreate: async () => ({ workspaceId: 'w1', paneId: 'w1:p1' }),
      workspaceClose: async () => void calls.push('close'),
      agentStart: async (_n: string, kind: string, _p: string, args: string[]) => void calls.push(`start ${kind} ${args.join(' ')}`),
      paneRead: async (_p: string, source = 'visible') => {
        if (usageOpen) return screens.usage;
        if (source === 'recent') return screens.final;
        return screens.initial[Math.min(readCount++, screens.initial.length - 1)]!;
      },
      paneSendKeys: async (_p: string, keys: string[]) => {
        calls.push(`keys ${keys.join(' ')}`);
        if (keys.includes('esc')) usageOpen = false;
      },
      paneSendText: async (_p: string, text: string) => {
        calls.push(`text ${text}`);
        if (text === '/usage') usageOpen = true;
      },
      promptAndWait: async () => ({ status: outcome }),
    };
    return { herdr: herdr as unknown as Herdr, calls };
  };

  it('answers the trust question, reads usage around the build, and writes job.json', async () => {
    const [trust, ready, usage] = await Promise.all([screen('claude-trust.txt'), screen('claude-ready.txt'), screen('claude-usage.txt')]);
    const { herdr, calls } = fakeHerdr({ initial: [trust, ready], usage, final: ready });
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'bm-runs-'));
    const { runJob } = await import('../src/runner/job.js');
    const task = await loadTask('web-01');
    const result = await runJob({
      runId: 'r1', runsRoot, task, model: 'sonnet', mode: 'bare', herdr, adapter: claudeAdapter,
      agentPaths: { claudeJson: '/none', claudeProjects: '/none', codexHome: '/none' },
      sleep: async () => {}, skipChecks: true,
    });

    expect(calls[0]).toMatch(/^start claude --safe-mode --dangerously-skip-permissions --session-id \S+ --model sonnet --effort medium$/);
    expect(calls).toContain('keys down enter');
    expect(calls.at(-1)).toBe('close');
    expect(result.status).toBe('completed');
    expect(result.phases[0]).toMatchObject({
      name: 'build', outcome: 'done', problem: null,
      quotaBefore: { window5hPct: 40, weekPct: 62 }, quotaAfter: { window5hPct: 40, weekPct: 62 },
    });
    expect(result.task.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const written = JSON.parse(await readFile(path.join(runsRoot, 'r1', 'web-01__sonnet__bare', 'job.json'), 'utf8'));
    expect(written.id).toBe('web-01__sonnet__bare');
  });

  it('retries the agent start while the new shell is not ready yet', async () => {
    const [ready, usage] = await Promise.all([screen('claude-ready.txt'), screen('claude-usage.txt')]);
    const { herdr } = fakeHerdr({ initial: [ready], usage, final: ready });
    let attempts = 0;
    (herdr as any).agentStart = async () => {
      if (++attempts < 3) throw new HerdrError('agent_pane_busy', 'not an available shell');
    };
    const { runJob } = await import('../src/runner/job.js');
    const result = await runJob({
      runId: 'r3', runsRoot: await mkdtemp(path.join(os.tmpdir(), 'bm-runs-')), task: await loadTask('web-01'),
      model: 'sonnet', mode: 'bare', herdr, adapter: claudeAdapter,
      agentPaths: { claudeJson: '/none', claudeProjects: '/none', codexHome: '/none' },
      sleep: async () => {}, skipChecks: true,
    });
    expect(attempts).toBe(3);
    expect(result.status).toBe('completed');
  });

  it('reports a usage limit seen on screen even when herdr says done', async () => {
    const [ready, usage, limit] = await Promise.all([screen('claude-ready.txt'), screen('claude-usage.txt'), screen('claude-limit.txt')]);
    const { herdr } = fakeHerdr({ initial: [ready], usage, final: limit });
    const { runJob } = await import('../src/runner/job.js');
    const result = await runJob({
      runId: 'r2', runsRoot: await mkdtemp(path.join(os.tmpdir(), 'bm-runs-')), task: await loadTask('web-01'),
      model: 'sonnet', mode: 'harness', herdr, adapter: claudeAdapter,
      agentPaths: { claudeJson: '/none', claudeProjects: '/none', codexHome: '/none' },
      sleep: async () => {}, skipChecks: true,
    });
    expect(result.status).toBe('quota_paused');
  });
});

describe('fix loop', () => {
  it('sends confirmed bugs back to the same session and re-checks until the product works', async () => {
    const [ready, usage] = await Promise.all([screen('claude-ready.txt'), screen('claude-usage.txt')]);
    const prompts: string[] = [];
    let readCount = 0;
    let usageOpen = false;
    let workDir = '';
    const herdr = {
      workspaceCreate: async (cwd: string) => { workDir = cwd; return { workspaceId: 'w1', paneId: 'w1:p1' }; },
      workspaceClose: async () => {},
      agentStart: async () => {},
      paneRead: async () => (usageOpen ? usage : (readCount++, ready)),
      paneSendKeys: async (_p: string, keys: string[]) => { if (keys.includes('esc')) usageOpen = false; },
      paneSendText: async (_p: string, t: string) => { if (t === '/usage') usageOpen = true; },
      promptAndWait: async (_n: string, text: string) => {
        prompts.push(text);
        // The fake agent ignores the build prompt, then applies the reference fix on the first bug report.
        if (text.startsWith('# Retours de recette')) {
          const { copyFile } = await import('node:fs/promises');
          for (const f of ['cart.js', 'app.js', 'style.css']) {
            await copyFile(path.join(here, 'fixtures/fix-01-solution', f), path.join(workDir, 'src', f));
          }
        }
        return { status: 'done' };
      },
    } as unknown as Herdr;

    const { runJob } = await import('../src/runner/job.js');
    // The loop is what is tested here: Lighthouse and the before / after capture are covered elsewhere
    // and would triple the run time.
    const fix01 = await loadTask('fix-01');
    const task = { ...fix01, beforeAfter: false, knownBugs: [], checks: fix01.checks.filter((c) => !(typeof c === 'object' && 'lighthouse' in c)) };
    const result = await runJob({
      runId: 'r-fix', runsRoot: await mkdtemp(path.join(os.tmpdir(), 'bm-runs-')), task,
      model: 'sonnet', mode: 'bare', herdr, adapter: claudeAdapter, tester: null,
      agentPaths: { claudeJson: '/none', claudeProjects: '/none', codexHome: '/none' },
      sleep: async () => {},
    });

    expect(result.phases.map((p) => p.name)).toEqual(['build', 'fix-1']);
    expect(result.qa.map((q) => q.round)).toEqual([0, 1]);
    expect(result.bugs.length).toBeGreaterThan(5);
    expect(result.bugs.every((b) => b.status === 'fixed' && b.fixedInRound === 1)).toBe(true);
    expect(result.bugs.map((b) => b.id)).toEqual(expect.arrayContaining(['C-visible_tests', 'C-hidden_tests', 'C-responsive', 'C-scenario.pay_contrast']));
    expect(result.verdict).toBe('works');
    // The bug report describes failing behaviours but never contains the hidden test files.
    expect(prompts[1]).toContain('MOINS5 : jamais négatif');
    expect(prompts[1]).not.toContain('cart.hidden.test.js');
    expect(prompts[1]).not.toContain('hidden-tests');
  }, 600_000);
});
