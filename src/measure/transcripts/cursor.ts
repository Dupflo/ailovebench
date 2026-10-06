import { stat } from 'node:fs/promises';
import { readJsonl, num } from '../jsonl.js';
import { addOnce, type ParsedSession } from '../types.js';

/**
 * Parses the stream-json output of `cursor-agent -p`, one file per phase (build, fix-1…).
 * Cursor reports usage once per turn (the `result` event), not per request: each turn becomes one
 * request. Its numbers match what Cursor bills (checked on the account usage dashboard).
 */
export async function parseCursorStreams(files: Array<{ phase: string; file: string }>, priceModel: string): Promise<ParsedSession> {
  const session: ParsedSession = {
    agent: 'cursor', sessionId: null, cwd: null, startedAt: null, endedAt: null, requests: [], messages: [],
    harness: { skills: [], mcp: [] },
  };
  for (const { phase, file } of files) {
    let lastTs: string | null = null;
    try {
      lastTs = new Date((await stat(file)).mtimeMs).toISOString();
    } catch {
      continue;
    }
    for await (const e of readJsonl(file)) {
      if (typeof e.timestamp_ms === 'number') lastTs = new Date(e.timestamp_ms).toISOString();
      session.sessionId ??= e.session_id ?? null;
      if (e.type === 'system' && e.subtype === 'init') {
        session.cwd ??= e.cwd ?? null;
      } else if (e.type === 'tool_call' && e.subtype === 'started') {
        const name = Object.keys(e.tool_call ?? {})[0] ?? '';
        if (/^mcp/i.test(name)) addOnce(session.harness.mcp, String(e.tool_call[name]?.args?.providerIdentifier ?? e.tool_call[name]?.args?.server ?? 'mcp'));
        const args = JSON.stringify(e.tool_call?.[name]?.args ?? {});
        for (const m of args.matchAll(/skills(?:-cursor)?\/([^/"\\]+)\/SKILL\.md/g)) addOnce(session.harness.skills, m[1]);
      } else if (e.type === 'assistant') {
        const text = (e.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').trim();
        if (text && lastTs) session.messages.push({ timestamp: lastTs, text });
      } else if (e.type === 'result' && e.usage) {
        const u = e.usage;
        const ts = lastTs ?? new Date().toISOString();
        session.requests.push({
          id: e.request_id ?? `${phase}#result`,
          model: priceModel,
          timestamp: ts,
          speed: 'standard',
          sidechain: false,
          usage: {
            input: num(u.inputTokens),
            output: num(u.outputTokens),
            cacheRead: num(u.cacheReadTokens),
            cacheWrite5m: num(u.cacheWriteTokens),
            cacheWrite1h: 0,
            reasoning: 0,
          },
        });
        session.startedAt ??= ts;
        session.endedAt = ts;
      }
    }
  }
  return session;
}
