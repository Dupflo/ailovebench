import { copyFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJsonl } from '../measure/jsonl.js';
import { parseCodexRollout } from '../measure/transcripts/codex.js';
import { rolloutsNewestFirst } from '../detect/subscriptions.js';
import type { AgentAdapter, PrepareContext, Prepared, QuotaReading } from './types.js';

/**
 * Reads Codex's `/status` block. Codex shows what is LEFT; the bench stores what is USED.
 *   Account:        Plus
 *   5h limit:       [███…] 97% left (resets 19:29)
 *   Weekly limit:   [███…] 88% left (resets 14:29 on 8 Oct)
 */
export function parseCodexStatusScreen(screen: string): QuotaReading | null {
  // Earlier /status blocks may still be on screen: the last one is the current reading.
  const used = (label: string): number | null => {
    const all = [...screen.matchAll(new RegExp(`${label}:.*?(\\d{1,3})% left`, 'g'))];
    const last = all.at(-1);
    return last ? 100 - Number(last[1]) : null;
  };
  const window5hPct = used('5h limit');
  const weekPct = used('Weekly limit');
  if (window5hPct === null && weekPct === null) return null;
  const plan = [...screen.matchAll(/Account:\s+(.+?)\s*$/gm)].at(-1)?.[1];
  return { window5hPct, weekPct, source: 'measured', ...(plan ? { plan } : {}) };
}

const exists = (f: string) => readFile(f).then(() => true, () => false);

/**
 * Mode bare: a per-job CODEX_HOME holding only what Codex needs to run (auth, model cache) and what
 * herdr needs to follow it (its SessionStart hook). Skills, AGENTS.md, MCP, plugins and the user's
 * config are left out; `skills.include_instructions = false` also hides `~/.agents/skills`.
 */
async function prepareBare(ctx: PrepareContext): Promise<Prepared> {
  const userHome = ctx.userCodexHome!;
  const home = path.join(ctx.root, 'codex-home');
  await mkdir(home, { recursive: true });

  const userAuth = path.join(userHome, 'auth.json');
  const auth = path.join(home, 'auth.json');
  await copyFile(userAuth, auth);
  await chmod(auth, 0o600);
  const authBefore = JSON.parse(await readFile(auth, 'utf8')).last_refresh ?? null;

  for (const f of ['models_cache.json', 'herdr-agent-state.sh']) {
    if (await exists(path.join(userHome, f))) await copyFile(path.join(userHome, f), path.join(home, f));
  }
  const hook = path.join(home, 'herdr-agent-state.sh');
  const hooks = (await exists(hook))
    ? { SessionStart: [{ hooks: [{ command: `bash '${hook}' session`, timeout: 10, type: 'command' }] }] }
    : {};
  await writeFile(path.join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  await writeFile(
    path.join(home, 'config.toml'),
    [
      'check_for_update_on_startup = false',
      '',
      '[skills]',
      'include_instructions = false',
      '',
      '[notice]',
      'hide_rate_limit_model_nudge = true',
      '',
      `[projects."${ctx.work}"]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'),
  );

  return {
    env: { CODEX_HOME: home },
    async cleanup() {
      // Codex may refresh its tokens during the job. If the copy is newer, it becomes the user's
      // token: OpenAI can rotate refresh tokens, and the old one may stop working.
      try {
        const copy = JSON.parse(await readFile(auth, 'utf8'));
        const user = JSON.parse(await readFile(userAuth, 'utf8'));
        const newer = copy.last_refresh && copy.last_refresh !== authBefore && copy.last_refresh > (user.last_refresh ?? '');
        if (newer) {
          const tmp = `${userAuth}.ailovebench-tmp`;
          await writeFile(tmp, JSON.stringify(copy, null, 2), { mode: 0o600 });
          await rename(tmp, userAuth);
        }
      } finally {
        await rm(auth, { force: true });
      }
    },
  };
}

export const codexAdapter: AgentAdapter = {
  kind: 'codex',

  async prepare(ctx) {
    if (ctx.mode === 'bare') return prepareBare(ctx);
    return { env: {}, cleanup: async () => {} };
  },

  launchArgs({ model, work, effort }) {
    return [
      '-m', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      // The model-switch suggestion would make the bench measure another model.
      '-c', 'notice.hide_rate_limit_model_nudge=true',
      // Trust only the sandbox, for this session, without writing to the user's config.
      '-c', `projects."${work}".trust_level="trusted"`,
    ];
  },

  startupKeys(screen) {
    if (/Trust and continue/.test(screen)) return ['enter'];
    if (/Keep current model/.test(screen)) return ['down', 'enter'];
    if (/Update available/.test(screen)) return ['down', 'enter'];
    if (/Hooks need review/.test(screen)) return ['down', 'enter'];
    return null;
  },

  isReady(screen) {
    return /\? for shortcuts/.test(screen) && codexAdapter.startupKeys(screen) === null;
  },

  screenProblem(screen) {
    const limit = screen.match(/.*hit your usage limit.*/i);
    if (limit) return { kind: 'quota', detail: limit[0].replace(/^\s*■\s*/, '').trim() };
    const api = screen.match(/.*■ .*("type":"error"|error).*/i);
    if (api) return { kind: 'api_error', detail: api[0].replace(/^\s*■\s*/, '').trim() };
    return null;
  },

  usageCommand: '/status',
  parseUsage: parseCodexStatusScreen,
  // /status prints a block in the transcript; Esc would start editing the previous message.
  usageDismissKeys: [],

  async locateTranscript({ work, env, paths }) {
    const sessions = path.join(env.CODEX_HOME ?? paths.codexHome, 'sessions');
    for (const file of await rolloutsNewestFirst(sessions, 200)) {
      for await (const line of readJsonl(file)) {
        if (line.type === 'session_meta') {
          if (line.payload?.cwd === work) return file;
          break;
        }
      }
    }
    return null;
  },

  parseTranscript: parseCodexRollout,
};
