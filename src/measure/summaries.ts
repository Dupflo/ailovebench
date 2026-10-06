import type { AgentMessage } from './types.js';

/** The end marker every agent is asked to write; it carries no information. */
const END = /\s*«?\s*TERMIN[ÉE]\s*»?\.?\s*$/i;

/**
 * What the agent said at the end of each phase: its last message written during the phase,
 * without the end marker (a bare « TERMINÉ » falls back to the message before it).
 */
export function phaseSummaries(
  messages: AgentMessage[],
  phases: Array<{ name: string; startedAt: string; endedAt: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of phases) {
    const from = Date.parse(p.startedAt);
    const to = Date.parse(p.endedAt) + 5_000;
    const inPhase = messages.filter((m) => {
      const t = Date.parse(m.timestamp);
      return t >= from && t <= to;
    });
    for (let i = inPhase.length - 1; i >= 0; i--) {
      const text = inPhase[i]!.text.replace(END, '').trim();
      if (text) {
        out[p.name] = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
        break;
      }
    }
  }
  return out;
}
