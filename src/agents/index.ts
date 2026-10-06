import { claudeAdapter, resolveClaudeModel } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter, isCursorModel } from './cursor.js';
import { commandVersion } from '../detect/exec.js';
import type { AgentAdapter } from './types.js';
import type { TesterConfig } from '../qa/tester.js';
import { tr } from '../i18n.js';

/**
 * `cursor:<model>` runs in Cursor; Claude models (claude-*, opus, sonnet, haiku, fable) in Claude
 * Code; everything else in Codex.
 */
export const adapterFor = (model: string): AgentAdapter => {
  if (isCursorModel(model)) return cursorAdapter;
  return resolveClaudeModel(model).startsWith('claude-') ? claudeAdapter : codexAdapter;
};

export const resolveModel = (m: string) => (isCursorModel(m) ? m : resolveClaudeModel(m));

/** Default tester: the other provider's model, so no model ever grades its own provider. */
export const DEFAULT_TESTER: Record<string, string> = { claude: 'gpt-6-astra', codex: 'claude-opus-5-5', cursor: 'claude-opus-5-5' };

/**
 * `auto`: the other provider. `none`: automatic checks only. Otherwise a model id.
 * Returns null (with a warning) when the tester's CLI is not installed.
 */
export async function pickTester(
  choice: string | undefined,
  testedKind: string,
  warn: (msg: string) => void = () => {},
): Promise<TesterConfig | null> {
  if (choice === 'none') return null;
  const model = resolveClaudeModel(!choice || choice === 'auto' ? DEFAULT_TESTER[testedKind]! : choice);
  const adapter = adapterFor(model);
  if (adapter.kind === testedKind) warn(tr(`Testeur du même fournisseur que le modèle testé (${adapter.kind}).`, `Tester from the same provider as the tested model (${adapter.kind}).`));
  if (!(await commandVersion(adapter.kind === 'cursor' ? 'cursor-agent' : adapter.kind))) {
    warn(tr(`${adapter.kind} n'est pas installé : recette par checks automatiques seulement.`, `${adapter.kind} is not installed: automatic checks only.`));
    return null;
  }
  return { adapter, model };
}
