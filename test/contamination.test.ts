import { describe, expect, it } from 'vitest';
import { findLeaks } from '../src/qa/contamination.js';
import { jailProfile } from '../src/runner/jail.js';

const ctx = {
  ownJob: '3d-01__cursor-grok-4.7-medium__bare',
  otherJobs: ['3d-01__claude-opus-5-5__bare', '3d-01__cursor-grok-4.7-medium__bare', '3d-01__cursor-grok-4.7-medium-fast__bare', '_archive'],
  runId: '20261001-153224',
  benchHomes: ['/Users/x/.ailovebench', '/Users/x/.benchmyself'],
  packageRoots: ['/Users/x/dev/ailovebench', 'node_modules/ailovebench'],
};

describe('contamination', () => {
  it('finds other jobs, other runs and ailovebench itself in a transcript', () => {
    const text = [
      '{"cmd":"cat ../3d-01__claude-opus-5-5__bare/job.json"}',
      '{"cmd":"ls /Users/x/.ailovebench/runs/20260930-101010/"}',
      '{"cmd":"ls /Users/x/.benchmyself/runs/20260929-090909/"}',
      `{"cmd":"import('/opt/homebrew/lib/node_modules/ailovebench/dist/checks/webgl.js')"}`,
      '{"path":"\\/Users\\/x\\/dev\\/ailovebench\\/catalog\\/3d-01\\/hidden\\/scenarios.mjs"}',
    ].join('\n');
    expect(findLeaks(text, ctx)).toEqual([
      { kind: 'other_job', target: '3d-01__claude-opus-5-5__bare', count: 1 },
      { kind: 'other_run', target: 'runs/20260930-101010', count: 1 },
      { kind: 'other_run', target: 'runs/20260929-090909', count: 1 },
      { kind: 'ailovebench', target: '/Users/x/dev/ailovebench', count: 1 },
      { kind: 'ailovebench', target: 'node_modules/ailovebench', count: 1 },
    ]);
  });

  it('ignores the job itself, its own run, a longer sibling name, and servers seen in ps', () => {
    const text = [
      'cd /Users/x/.ailovebench/runs/20261001-153224/3d-01__cursor-grok-4.7-medium__bare/work && npm run build',
      '55363 node /Users/x/.ailovebench/runs/20261001-153224/3d-01__claude-opus-5-5__bare/work/node_modules/.bin/vite --port 5173',
    ].join('\n');
    expect(findLeaks(text, ctx)).toEqual([]);
  });
});

describe('sandbox profile', () => {
  it('denies ailovebench folders, then re-allows the job', () => {
    const p = jailProfile(['/Users/x/.ailovebench', '/Users/x/dev/ailovebench'], ['/Users/x/.ailovebench/runs/r/job']);
    expect(p.split('\n')).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny file-read* file-write* (subpath "/Users/x/.ailovebench"))',
      '(deny file-read* file-write* (subpath "/Users/x/dev/ailovebench"))',
      '(allow file-read-metadata (literal "/Users/x/.ailovebench/runs/r"))',
      '(allow file-read-metadata (literal "/Users/x/.ailovebench/runs"))',
      '(allow file-read-metadata (literal "/Users/x/.ailovebench"))',
      '(allow file-read* file-write* (subpath "/Users/x/.ailovebench/runs/r/job"))',
      '',
    ]);
  });
});

describe('rename to ailovebench', () => {
  it('moves the old folder to ~/.ailovebench and leaves a link behind', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, lstat } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { migrateLegacyHome } = await import('../src/paths.js');
    const home = await mkdtemp(path.join(os.tmpdir(), 'bm-home-'));
    await mkdir(path.join(home, '.benchmyself', 'runs', 'r1'), { recursive: true });
    await writeFile(path.join(home, '.benchmyself', 'runs', 'r1', 'run.json'), '{}');
    expect(migrateLegacyHome(home)).toBe(path.join(home, '.ailovebench'));
    expect(await readFile(path.join(home, '.ailovebench', 'runs', 'r1', 'run.json'), 'utf8')).toBe('{}');
    expect((await lstat(path.join(home, '.benchmyself'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(home, '.benchmyself', 'runs', 'r1', 'run.json'), 'utf8')).toBe('{}');
    expect(migrateLegacyHome(home)).toBeNull();
  });

  it('also moves ~/.ilovebench and repoints the older ~/.benchmyself link', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, symlink } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { migrateLegacyHome } = await import('../src/paths.js');
    const home = await mkdtemp(path.join(os.tmpdir(), 'bm-home-'));
    await mkdir(path.join(home, '.ilovebench', 'runs'), { recursive: true });
    await writeFile(path.join(home, '.ilovebench', 'runs', 'x'), 'ok');
    await symlink(path.join(home, '.ilovebench'), path.join(home, '.benchmyself'));
    expect(migrateLegacyHome(home)).toBe(path.join(home, '.ailovebench'));
    for (const old of ['.ilovebench', '.benchmyself']) expect(await readFile(path.join(home, old, 'runs', 'x'), 'utf8')).toBe('ok');
  });
});
