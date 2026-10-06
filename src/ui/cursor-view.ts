#!/usr/bin/env node
/**
 * Reads cursor-agent's stream-json on stdin and prints one readable line per step, so the herdr
 * pane stays watchable. The raw stream is saved by `tee` before this filter.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { tr } from '../i18n.js';

// The pane may close first (Ctrl+C, end of phase): never crash on a closed pipe.
process.stdout.on('error', () => process.exit(0));

const short = (s: unknown, n = 110) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const rl = createInterface({ input: process.stdin });
let thinking = false;
for await (const line of rl) {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type === 'thinking' && e.subtype === 'delta' && !thinking) {
    thinking = true;
    process.stdout.write(`  · ${tr('réflexion…', 'thinking…')}\n`);
  }
  if (e.type === 'thinking' && e.subtype === 'completed') thinking = false;
  if (e.type === 'system' && e.subtype === 'init') process.stdout.write(`▶ ${e.model} · session ${String(e.session_id).slice(0, 8)}\n`);
  if (e.type === 'tool_call' && e.subtype === 'started') {
    const name = Object.keys(e.tool_call ?? {})[0] ?? 'outil';
    const args = e.tool_call?.[name]?.args ?? {};
    const raw = args.command ?? args.path ?? args.pattern ?? args.query ?? '';
    const what = typeof raw === 'string' && raw.startsWith(process.cwd()) ? path.relative(process.cwd(), raw) || '.' : raw;
    process.stdout.write(`  🔧 ${name.replace(/ToolCall$/, '')} ${short(what)}\n`);
  }
  if (e.type === 'assistant') {
    const text = (e.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ');
    if (text.trim()) process.stdout.write(`  💬 ${short(text, 300)}\n`);
  }
  if (e.type === 'result') {
    const u = e.usage ?? {};
    process.stdout.write(`■ ${e.subtype} · ${Math.round((e.duration_ms ?? 0) / 1000)} s · ${u.inputTokens ?? 0} ${tr('entrée', 'input')} / ${u.outputTokens ?? 0} ${tr('sortie', 'output')} / ${u.cacheReadTokens ?? 0} cache\n`);
  }
}
