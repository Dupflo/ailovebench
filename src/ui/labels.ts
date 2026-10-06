import type { Mode } from '../agents/types.js';
import type { HarnessUse } from '../measure/types.js';
import { tr } from '../i18n.js';

/** 'bare' / 'harness' in the code; what people read is whether the agent ran with their own setup. */
export const modeLabel = (mode: Mode | string): string => (mode === 'bare' ? tr('sans harness', 'no harness') : tr('avec harness', 'with harness'));

export const noHarnessHelp = (): string =>
  tr(
    "Agent brut : aucune instruction perso (CLAUDE.md, AGENTS.md), aucune skill, aucun plugin, aucun MCP ni hook n'est chargé. On mesure le modèle seul.",
    'Bare agent: no personal instructions (CLAUDE.md, AGENTS.md), skills, plugins, MCP servers or hooks are loaded. Only the model is measured.',
  );

export const harnessHelp = (): string =>
  tr(
    'Agent avec ta config locale : tes instructions (CLAUDE.md, AGENTS.md), skills, plugins, serveurs MCP et hooks sont chargés, comme au quotidien.',
    'Agent with your local setup: your instructions (CLAUDE.md, AGENTS.md), skills, plugins, MCP servers and hooks are loaded, as in daily use.',
  );

/** Hover text for a job's mode: what the mode means, and for a harness run what was actually used. */
export function modeHelp(mode: Mode | string, used?: HarnessUse, agent?: string): string {
  if (mode === 'bare') {
    return agent === 'cursor'
      ? `${noHarnessHelp()}\n${tr(
          'Cursor : partiel. Les règles enregistrées dans le compte Cursor (côté serveur) et les skills intégrées à Cursor restent chargées.',
          'Cursor: partial. Rules saved in the Cursor account (server side) and skills built into Cursor stay loaded.',
        )}`
      : noHarnessHelp();
  }
  const skills = used?.skills.length ? used.skills.join(', ') : tr('aucune', 'none');
  const mcp = used?.mcp.length ? used.mcp.join(', ') : tr('aucun', 'none');
  return `${harnessHelp()}\n${tr('Skills utilisées pendant ce run', 'Skills used during this run')} : ${skills}\n${tr('Serveurs MCP utilisés', 'MCP servers used')} : ${mcp}${used ? '' : `\n${tr('(transcript introuvable : usage non mesuré)', '(transcript not found: usage not measured)')}`}`;
}
