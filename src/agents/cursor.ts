import { mkdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../measure/jsonl.js';
import { parseCursorStreams } from '../measure/transcripts/cursor.js';
import { run } from '../detect/exec.js';
import { loadPrices } from '../measure/prices.js';
import { tr } from '../i18n.js';

const PRICED = new Set(Object.keys(loadPrices().models));
import type { AgentAdapter, PrepareContext, Prepared, ScreenProblem } from './types.js';

/** Bench ids for Cursor models carry a prefix: Cursor's names overlap with Claude Code's. */
export const CURSOR_PREFIX = 'cursor:';
export const isCursorModel = (m: string) => m.startsWith(CURSOR_PREFIX);
export const cursorModelId = (m: string) => (isCursorModel(m) ? m.slice(CURSOR_PREFIX.length) : m);

const ANSI = /\x1b\[[0-9;]*m/g;

/** `cursor-agent --list-models` → ids and labels (the account's models, `auto` left out). */
export function parseCursorModels(output: string): Array<{ id: string; label: string }> {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.match(/^\s*([a-z0-9][a-z0-9.\-]*)\s+-\s+(.+?)\s*$/i))
    .filter((m): m is RegExpMatchArray => !!m && m[1] !== 'auto')
    .map((m) => ({ id: m[1]!, label: m[2]!.replace(/\s*\((current|default)[^)]*\)\s*$/i, '').replace(/[​]/g, '').trim() }));
}

/**
 * The price-table model a Cursor model stands for: `claude-opus-5-5-high-fast` → `claude-opus-5-5`
 * (effort / speed / thinking variants of a known model). Cursor-only models (Composer, Grok…) stay
 * as they are, so they show as « non chiffré » unless their price is in the table.
 */
export function cursorPriceModel(id: string): string {
  let base = cursorModelId(id);
  // A variant with its own price (composer-2.5-fast) keeps it.
  if (PRICED.has(base)) return base;
  const fast = /-fast(-|$)/.test(base);
  for (let i = 0; i < 4; i++) base = base.replace(/-(low|medium|high|xhigh|fast|thinking)$/, '');
  // Effort is not priced, speed is: grok-4.7-medium-fast → grok-4.7-fast.
  return fast && PRICED.has(`${base}-fast`) ? `${base}-fast` : base;
}

/**
 * Without harness: a throwaway HOME (no ~/.cursor skills, rules, plugins, MCP, nor ~/.agents skills)
 * and an empty CURSOR_CONFIG_DIR. Authentication lives in the macOS keychain, reached through a link
 * to the user's Keychains folder. Rules saved in the Cursor account (server side) still apply.
 */
async function prepareBare(ctx: PrepareContext): Promise<Prepared> {
  const home = path.join(ctx.root, 'cursor-home');
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  if (process.platform === 'darwin') {
    await mkdir(path.join(home, 'Library'), { recursive: true });
    await symlink(path.join(os.homedir(), 'Library', 'Keychains'), path.join(home, 'Library', 'Keychains')).catch(() => {});
  }
  return { env: { HOME: home, CURSOR_CONFIG_DIR: path.join(home, '.cursor') }, cleanup: async () => {} };
}

/** Readable view of the stream in the herdr pane (the raw stream is saved by tee). */
const VIEWER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'cursor-view.js');

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Absolute path: without harness, HOME is a throwaway folder and the shell no longer finds it in PATH. */
function cursorBin(): string {
  for (const p of [path.join(os.homedir(), '.local', 'bin', 'cursor-agent'), '/opt/homebrew/bin/cursor-agent', '/usr/local/bin/cursor-agent']) {
    if (existsSync(p)) return p;
  }
  return 'cursor-agent';
}

export const cursorAdapter: AgentAdapter = {
  kind: 'cursor',

  async prepare(ctx) {
    return ctx.mode === 'bare' ? prepareBare(ctx) : { env: {}, cleanup: async () => {} };
  },

  // Script mode: the command is built per phase by `headless.command`.
  launchArgs: () => [],
  startupKeys: () => null,
  isReady: () => true,
  screenProblem: () => null,
  usageCommand: '',
  parseUsage: () => null,
  usageDismissKeys: [],
  locateTranscript: async () => null,
  parseTranscript: (file) => parseCursorStreams([{ phase: 'build', file }], 'unknown'),

  headless: {
    command({ model, sessionId, promptFile, outFile }) {
      const id = cursorModelId(model);
      return [
        `${shellQuote(cursorBin())} -p --output-format stream-json --model ${id} --force --trust`,
        sessionId ? `--resume ${sessionId}` : '',
        `"$(cat ${shellQuote(promptFile)})"`,
        `| tee ${shellQuote(outFile)}`,
        `| ${shellQuote(process.execPath)} ${shellQuote(VIEWER)}`,
      ]
        .filter(Boolean)
        .join(' ');
    },

    async readPhase(outFile) {
      let sessionId: string | null = null;
      let result: any = null;
      for await (const e of readJsonl(outFile)) {
        sessionId ??= e.session_id ?? null;
        if (e.type === 'result') result = e;
      }
      let problem: ScreenProblem | null = null;
      if (!result) problem = { kind: 'api_error', detail: tr('aucun résultat dans la sortie de cursor-agent', 'no result in the cursor-agent output') };
      else if (result.is_error || result.subtype !== 'success') {
        const detail = String(result.result ?? result.error ?? result.subtype ?? 'erreur');
        problem = { kind: /limit|quota|usage/i.test(detail) ? 'quota' : 'api_error', detail: detail.slice(0, 300) };
      }
      return { sessionId, problem, ok: !problem };
    },

    parsePhases: (files, model) => parseCursorStreams(files, cursorPriceModel(model)),
  },
};

/** Models offered to the logged-in Cursor account, as `cursor:<id>`. */
export async function readCursorModels(): Promise<string[]> {
  const out = await run('cursor-agent', ['--list-models'], 20_000);
  return out ? parseCursorModels(out).map((m) => `${CURSOR_PREFIX}${m.id}`) : [];
}

/** Subscription tier shown by `cursor-agent about` (« Pro »…). */
export async function readCursorPlan(): Promise<string | null> {
  const out = await run('cursor-agent', ['about'], 20_000);
  return out?.replace(ANSI, '').match(/Subscription Tier\s+(.+)/)?.[1]?.trim() ?? null;
}
