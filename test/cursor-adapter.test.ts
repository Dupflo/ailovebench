import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCursorStreams } from '../src/measure/transcripts/cursor.js';
import { adapterFor, resolveModel } from '../src/agents/index.js';
import { cursorAdapter, parseCursorModels, cursorPriceModel } from '../src/agents/cursor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stream = path.join(here, 'fixtures/cursor/build.jsonl');

describe('Cursor stream', () => {
  it('turns each turn result into one request with its usage, and keeps messages and the session id', async () => {
    const s = await parseCursorStreams([{ phase: 'build', file: stream }], 'composer-2.5');
    expect(s.agent).toBe('cursor');
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.usage).toEqual({ input: 9123, output: 95, cacheRead: 16853, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 });
    expect(s.requests[0]!.model).toBe('composer-2.5');
    expect(s.messages.at(-1)!.text).toBe('TERMINÉ');
  });
});

describe('Cursor models', () => {
  it('routes cursor: models to the Cursor agent, even when the name looks like Claude', () => {
    expect(adapterFor('cursor:claude-opus-5-5-medium').kind).toBe('cursor');
    expect(adapterFor('cursor:composer-2.5').kind).toBe('cursor');
    expect(adapterFor('claude-opus-5-5').kind).toBe('claude');
    expect(resolveModel('cursor:composer-2.5')).toBe('cursor:composer-2.5');
  });

  it('reads the model list printed by the CLI', () => {
    const out = '\x1b[2mAvailable models\x1b[22m\n\n\x1b[32mauto\x1b[39m - Auto (current, default)\n\x1b[36mcomposer-2.5\x1b[39m - Composer 2.5\n\x1b[36mclaude-opus-5-5-high\x1b[39m - Claude Opus 5.5 1M High\n';
    expect(parseCursorModels(out)).toEqual([
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 1M High' },
    ]);
  });

  it('prices a model served by Cursor as its base model, and never guesses Cursor-only ones', () => {
    expect(cursorPriceModel('claude-opus-5-5-high-fast')).toBe('claude-opus-5-5');
    expect(cursorPriceModel('gpt-5.6-sol-xhigh')).toBe('gpt-5.6-sol');
    expect(cursorPriceModel('claude-sonnet-5-thinking-high')).toBe('claude-sonnet-5');
    expect(cursorPriceModel('composer-2.5')).toBe('composer-2.5');
    expect(cursorPriceModel('composer-2.5-fast')).toBe('composer-2.5-fast');
    expect(cursorPriceModel('cursor-grok-4.6-high')).toBe('cursor-grok-4.6');
  });

  it('builds a script-mode command that resumes the session for fix rounds', () => {
    const cmd = cursorAdapter.headless!.command({ model: 'composer-2.5', sessionId: 'abc', promptFile: '/tmp/p.md', outFile: '/tmp/o.jsonl' });
    expect(cmd).toMatch(/cursor-agent' -p --output-format stream-json --model composer-2\.5 --force --trust --resume abc/);
    expect(cmd).toContain('"$(cat \'/tmp/p.md\')"');
    expect(cmd).toContain("tee '/tmp/o.jsonl'");
  });
});

describe('script mode end without cursor-agent result', () => {
  it('counts a silent stream ending with « TERMINÉ » as finished, not one with a running tool', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { streamSettled } = await import('../src/runner/session.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bm-settle-'));
    const ev = (o: object) => JSON.stringify(o);
    const done = path.join(dir, 'done.jsonl');
    await writeFile(done, [ev({ type: 'tool_call', subtype: 'started', call_id: 'a' }), ev({ type: 'tool_call', subtype: 'completed', call_id: 'a' }), ev({ type: 'thinking', subtype: 'delta', text: 'Tout est vérifié. TERMINÉ.' })].join('\n'));
    const busy = path.join(dir, 'busy.jsonl');
    await writeFile(busy, [ev({ type: 'thinking', subtype: 'delta', text: 'TERMINÉ' }), ev({ type: 'tool_call', subtype: 'started', call_id: 'b' })].join('\n'));
    const notYet = path.join(dir, 'not.jsonl');
    await writeFile(notYet, ev({ type: 'thinking', subtype: 'delta', text: "Ce n'est pas encore terminé." }));
    const later = Date.now() + 10 * 60_000;
    expect(await streamSettled(done, later)).toBe(true);
    expect(await streamSettled(busy, later)).toBe(false);
    expect(await streamSettled(notYet, later)).toBe(false);
    expect(await streamSettled(done)).toBe(false); // still fresh
  });
});
