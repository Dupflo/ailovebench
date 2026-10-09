import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { activeTime, findProjectSessions, isInside, measureProject, parseBound } from '../src/measure/project.js';
import { parseCodexRollout } from '../src/measure/transcripts/codex.js';
import { loadPrices } from '../src/measure/prices.js';
import { projectMarkdown, projectText } from '../src/project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures/project');
const paths = { claudeJson: '/nonexistent', claudeProjects: path.join(fixtures, 'claude/projects'), codexHome: path.join(fixtures, 'codex') };
const prices = loadPrices();

describe('project folder matching', () => {
  it('matches the folder and its subfolders, not a sibling sharing its prefix', () => {
    expect(isInside('/work/site', '/work/site', 'linux')).toBe(true);
    expect(isInside('/work/site', '/work/site/wp-content/themes', 'linux')).toBe(true);
    expect(isInside('/work/site/', '/work/site', 'linux')).toBe(true);
    expect(isInside('/work/site', '/work/site-old', 'linux')).toBe(false);
    expect(isInside('/work/site', '/work', 'linux')).toBe(false);
  });

  it('ignores case and separators on Windows', () => {
    expect(isInside('C:\\Users\\Ana\\Site', 'c:/users/ana/site/wp-content', 'win32')).toBe(true);
    expect(isInside('C:\\Users\\Ana\\Site', 'C:\\Users\\Ana\\Site2', 'win32')).toBe(false);
    expect(isInside('C:\\Users\\Ana\\Site', 'D:\\Users\\Ana\\Site', 'win32')).toBe(false);
  });

  it('finds Claude sessions (any slug) and Codex rollouts (archived too) by their cwd', async () => {
    const found = await findProjectSessions('/work/site', paths);
    expect(found.map((f) => `${f.tool}:${path.basename(f.file)}`).sort()).toEqual([
      'claude:s-main.jsonl',
      'claude:s-resumed.jsonl',
      'claude:s-theme.jsonl',
      'codex:rollout-2026-10-02T11-00-00-cx-1.jsonl',
      'codex:rollout-2026-10-04T08-00-00-cx-arch.jsonl',
    ]);
  });
});

describe('Codex cache writes', () => {
  it('moves cache_write_input_tokens out of input, billed as a cache write', async () => {
    const s = await parseCodexRollout(path.join(fixtures, 'codex/sessions/2026/10/02/rollout-2026-10-02T11-00-00-cx-1.jsonl'));
    expect(s.requests.map((r) => r.usage)).toEqual([
      { input: 3000, output: 500, cacheWrite5m: 1000, cacheWrite1h: 0, cacheRead: 6000, reasoning: 100 },
      { input: 0, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2000, reasoning: 50 },
    ]);
  });
});

describe('measureProject', () => {
  it('sums Claude (subagents included) and Codex, once per request, split by tool and model', async () => {
    const r = await measureProject('/work/site', { paths, prices });
    expect(r.sessions).toEqual({ total: 5, claude: 3, codex: 2 });
    // m1, m-sub, m2 (also copied into the resumed session), m3, t1 + 2 Codex + 1 archived Codex.
    expect(r.summary.total.requests).toBe(8);
    expect(r.byTool.map((b) => [b.tool, b.requests])).toEqual([['claude', 5], ['codex', 3]]);
    expect(r.byTool[0]!.usage.cacheWrite5m).toBe(2000);
    expect(r.byTool[1]!.usage.cacheWrite5m).toBe(1000);
    expect(r.byModel.find((m) => m.model === 'claude-haiku-4-5')?.requests).toBe(1);
    expect(r.byModel.find((m) => m.model === 'gpt-5.5')?.tools).toEqual(['codex']);
    expect(r.start).toBe('2026-10-01T09:00:10.000Z');
    expect(r.end).toBe('2026-10-04T08:00:10.000Z');
    // 09:00:10 → 09:05:00 on day one, then 10 s between the two Codex requests; the rest are pauses.
    expect(r.activeMs).toBe(300_000);
  });

  it('reports an unpriced model as such, never as 0 $', async () => {
    const r = await measureProject('/work/site', { paths, prices });
    expect(r.summary.unpricedModels).toEqual(['gpt-unpriced-test']);
    expect(r.summary.total.cost.kind).toBe('partial');
    const unpriced = r.byModel.find((m) => m.model === 'gpt-unpriced-test')!;
    expect(unpriced.cost.value).toBeNull();
    expect(projectText(r)).toMatch(/gpt-unpriced-test .* non tarifé/);
    expect(projectMarkdown(r)).toContain('non tarifé');
  });

  it('counts only requests inside --since / --until', async () => {
    const r = await measureProject('/work/site', { paths, prices, since: new Date('2026-10-02T00:00:00Z'), until: new Date('2026-10-03T23:59:59Z') });
    // t1, the 2 Codex requests of cx-1, m3: m2 in the resumed session is from 10-01.
    expect(r.summary.total.requests).toBe(4);
    expect(r.sessions).toEqual({ total: 3, claude: 2, codex: 1 });
  });

  it('only ever outputs numbers and model names, never the conversation', async () => {
    const r = await measureProject('/work/site', { paths, prices });
    for (const out of [JSON.stringify(r), projectText(r), projectMarkdown(r)]) expect(out).not.toMatch(/SECRET/);
  });

  it('says so when no session matches', async () => {
    const r = await measureProject('/nowhere', { paths, prices });
    expect(r.summary.total.requests).toBe(0);
    expect(projectText(r)).toContain('Aucune session');
  });
});

describe('period and active time', () => {
  it('reads a bare date as the whole local day', () => {
    expect(parseBound('2026-10-01', 'since')!.getTime()).toBe(new Date(2026, 9, 1).getTime());
    expect(parseBound('2026-10-01', 'until')!.getTime()).toBe(new Date(2026, 9, 2).getTime() - 1);
    expect(parseBound('2026-10-01T09:30:00Z', 'since')!.toISOString()).toBe('2026-10-01T09:30:00.000Z');
    expect(parseBound('yesterday', 'since')).toBeNull();
  });

  it('leaves pauses out of the active time', () => {
    expect(activeTime(['2026-10-01T10:00:00Z', '2026-10-01T10:10:00Z', '2026-10-01T12:00:00Z', '2026-10-01T12:01:00Z'])).toBe(11 * 60_000);
  });
});

describe('ailovebench project (CLI)', () => {
  it('runs without a TTY, exits 0 and writes docs/couts.md in the measured folder by default', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ailovebench-project-'));
    const site = path.join(tmp, 'site');
    const claude = path.join(tmp, 'claude-config');
    await mkdir(path.join(claude, 'projects', 'slug'), { recursive: true });
    await mkdir(site);
    const line = (o: object) => JSON.stringify(o);
    await writeFile(
      path.join(claude, 'projects', 'slug', 's.jsonl'),
      [
        line({ type: 'user', timestamp: '2026-10-01T09:00:00Z', sessionId: 's', cwd: site, message: { role: 'user', content: 'hi' } }),
        line({ type: 'assistant', timestamp: '2026-10-01T09:00:05Z', sessionId: 's', cwd: site, message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1000 } } }),
      ].join('\n'),
    );
    const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
    const { stdout } = await promisify(execFile)(tsx, [path.join(here, '..', 'src', 'cli.ts'), 'project', site, '--write'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(tmp, 'no-codex'), AILOVEBENCH_HOME: path.join(tmp, 'home') },
    });
    expect(stdout).toContain('Sessions 1 (Claude 1)');
    const md = await readFile(path.join(site, 'docs', 'couts.md'), 'utf8');
    expect(md).toContain('# Coût du projet « site » en tokens');
    expect(md).toContain("Ce n'est pas une facture.");
    // 1000 input × 4 $ + 1000 output × 20 $ per million on Opus 5.5.
    expect(md).toMatch(/Coût équivalent API total : ≈ 0,02 \$/);
  });
});
