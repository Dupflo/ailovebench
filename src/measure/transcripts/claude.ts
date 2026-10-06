import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonl, num } from '../jsonl.js';
import { addOnce, type ModelRequest, type ParsedSession } from '../types.js';

/**
 * Parses a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`) and its
 * subagent transcripts (`<session>/subagents/*.jsonl`).
 *
 * Claude Code writes one `assistant` line per content block, repeating the same `usage`;
 * requests are deduplicated by `message.id`, keeping the last line (its `output_tokens` is final).
 */
export async function parseClaudeSession(file: string): Promise<ParsedSession> {
  const session: ParsedSession = {
    agent: 'claude', sessionId: null, cwd: null, startedAt: null, endedAt: null, requests: [], messages: [], harness: { skills: [], mcp: [] },
  };
  const byId = new Map<string, ModelRequest>();

  await collect(file, false, session, byId);
  const subDir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  for (const sub of await listJsonl(subDir)) await collect(sub, true, null, byId);

  session.requests = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return session;
}

async function collect(
  file: string,
  sidechain: boolean,
  meta: ParsedSession | null,
  byId: Map<string, ModelRequest>,
): Promise<void> {
  for await (const line of readJsonl(file)) {
    if (meta) {
      meta.sessionId ??= line.sessionId ?? null;
      meta.cwd ??= line.cwd ?? null;
      if (line.timestamp) {
        meta.startedAt ??= line.timestamp;
        const real = line.type === 'user' || (line.type === 'assistant' && line.message?.model !== '<synthetic>');
        if (real) meta.endedAt = line.timestamp;
      }
    }
    if (line.type !== 'assistant') continue;
    const msg = line.message;
    if (meta && Array.isArray(msg?.content)) {
      for (const c of msg.content) {
        if (c?.type !== 'tool_use') continue;
        if (c.name === 'Skill') addOnce(meta.harness.skills, c.input?.skill);
        else if (typeof c.name === 'string' && c.name.startsWith('mcp__')) addOnce(meta.harness.mcp, c.name.split('__')[1]);
      }
    }
    if (meta && !line.isSidechain && Array.isArray(msg?.content)) {
      const text = msg.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').trim();
      if (text) meta.messages.push({ timestamp: line.timestamp, text });
    }
    if (!msg?.id || !msg.usage || msg.model === '<synthetic>') continue;
    const u = msg.usage;
    byId.set(msg.id, {
      id: msg.id,
      model: msg.model,
      timestamp: line.timestamp,
      speed: u.speed === 'fast' ? 'fast' : 'standard',
      sidechain: sidechain || line.isSidechain === true,
      usage: {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheWrite5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
        cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        reasoning: num(u.output_tokens_details?.thinking_tokens),
      },
    });
  }
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
