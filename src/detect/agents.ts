import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadPrices } from '../measure/prices.js';
import { commandVersion } from './exec.js';
import { readCursorModels } from '../agents/cursor.js';

export interface AgentInfo {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  /** Models the user can run with this agent; empty when unknown or not installed. */
  models: string[];
  installHint: string;
  /** Whether ailovebench can drive this agent yet. */
  supported: boolean;
}

interface KnownAgent {
  id: string;
  label: string;
  bin: string;
  installHint: string;
  supported: boolean;
}

const KNOWN: KnownAgent[] = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', installHint: 'npm install -g @anthropic-ai/claude-code', supported: true },
  { id: 'codex', label: 'Codex CLI', bin: 'codex', installHint: 'npm install -g @openai/codex', supported: true },
  { id: 'cursor', label: 'Cursor (CLI)', bin: 'cursor-agent', installHint: 'curl https://cursor.com/install -fsS | bash', supported: true },
  { id: 'gemini', label: 'Gemini CLI', bin: 'gemini', installHint: 'npm install -g @google/gemini-cli', supported: false },
  { id: 'opencode', label: 'opencode', bin: 'opencode', installHint: 'npm install -g opencode-ai', supported: false },
  { id: 'ollama', label: 'Ollama', bin: 'ollama', installHint: 'https://ollama.com/download', supported: false },
  { id: 'lmstudio', label: 'LM Studio', bin: 'lms', installHint: 'https://lmstudio.ai', supported: false },
];

/** Claude Code exposes no local model list: use the priced Anthropic models. */
export function claudeModels(): string[] {
  return Object.entries(loadPrices().models)
    .filter(([, p]) => p.provider === 'anthropic')
    .map(([id]) => id);
}

/** Models offered to the logged-in account, as cached by the Codex CLI. */
export async function readCodexModels(codexHome: string): Promise<string[]> {
  try {
    const cache = JSON.parse(await readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
    return (cache.models ?? [])
      .filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string')
      .map((m: any) => m.slug as string);
  } catch {
    return [];
  }
}

export async function detectAgents(codexHome: string): Promise<AgentInfo[]> {
  return Promise.all(
    KNOWN.map(async (a) => {
      const version = await commandVersion(a.bin);
      const installed = version !== null;
      let models: string[] = [];
      if (installed && a.id === 'claude') models = claudeModels();
      if (installed && a.id === 'codex') models = await readCodexModels(codexHome);
      if (installed && a.id === 'cursor') models = await readCursorModels();
      return { id: a.id, label: a.label, installed, version, models, installHint: a.installHint, supported: a.supported };
    }),
  );
}
