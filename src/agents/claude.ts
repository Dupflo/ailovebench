import { locateSession } from '../measure/locate.js';
import { parseClaudeSession } from '../measure/transcripts/claude.js';
import type { AgentAdapter, QuotaReading } from './types.js';

/**
 * Reads Claude Code's `/usage` screen:
 *   Current session ... 40% used        → 5-hour window
 *   Current week (all models) ... 62% used
 */
export function parseClaudeUsageScreen(screen: string): QuotaReading | null {
  const pctAfter = (label: RegExp): number | null => {
    const m = screen.match(new RegExp(`${label.source}[\\s\\S]*?(\\d{1,3})% used`));
    return m ? Number(m[1]) : null;
  };
  const window5hPct = pctAfter(/Current session/);
  const weekPct = pctAfter(/Current week \(all models\)/);
  if (window5hPct === null && weekPct === null) return null;
  return { window5hPct, weekPct, source: 'measured' };
}

/** Short names accepted on the command line; full ids are passed to Claude Code so runs are explicit. */
const CLAUDE_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

export const resolveClaudeModel = (m: string): string => CLAUDE_ALIASES[m] ?? m;

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  async prepare() {
    return { env: {}, cleanup: async () => {} };
  },

  launchArgs({ mode, model, sessionId, effort }) {
    // bare: no CLAUDE.md, skills, plugins, hooks, MCP. Both modes run in a disposable sandbox.
    return [
      ...(mode === 'bare' ? ['--safe-mode'] : []),
      '--dangerously-skip-permissions',
      '--session-id', sessionId,
      '--model', model,
      '--effort', effort,
    ];
  },

  startupKeys(screen) {
    // Asked once per git repository, even with --dangerously-skip-permissions.
    if (/Yes, I trust this folder/.test(screen)) return ['down', 'enter'];
    return null;
  },

  isReady(screen) {
    return /⏵⏵|bypass permissions on|\? for shortcuts/.test(screen) && !/trust this folder/.test(screen);
  },

  screenProblem(screen) {
    // Limit wording is not verified yet on a real limit (spike S6): kept deliberately broad.
    const limit = screen.match(/.*(hit your (session |weekly )?limit|usage limit reached|limit reached).*/i);
    if (limit) return { kind: 'quota', detail: limit[0].trim() };
    const api = screen.match(/.*API Error.*/);
    if (api) return { kind: 'api_error', detail: api[0].trim() };
    return null;
  },

  usageCommand: '/usage',
  parseUsage: parseClaudeUsageScreen,
  usageDismissKeys: ['esc'],

  async locateTranscript({ sessionId, paths }) {
    return (await locateSession(sessionId, paths))?.file ?? null;
  },

  parseTranscript: parseClaudeSession,
};
