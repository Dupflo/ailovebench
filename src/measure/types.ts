/** Tokens of one request, split by how they are billed. Categories never overlap. */
export interface TokenUsage {
  /** Uncached input. */
  input: number;
  /** Output, reasoning included. */
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** Reasoning share of `output` (informative, already counted in `output`). */
  reasoning: number;
}

export interface ModelRequest {
  id: string;
  model: string;
  /** ISO 8601. */
  timestamp: string;
  usage: TokenUsage;
  speed: 'standard' | 'fast';
  /** True for subagent requests. */
  sidechain: boolean;
}

/** Text the agent wrote to the user (main thread only), used for per-phase summaries. */
export interface AgentMessage {
  timestamp: string;
  text: string;
}

export interface ParsedSession {
  agent: 'claude' | 'codex' | 'cursor';
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  requests: ModelRequest[];
  messages: AgentMessage[];
  /** What of the user's harness the agent actually used during the session. */
  harness: HarnessUse;
}

export interface HarnessUse {
  skills: string[];
  /** MCP servers whose tools were called. */
  mcp: string[];
}

/** Adds a name once, keeping first-use order. */
export const addOnce = (list: string[], name: string | undefined) => {
  if (name && !list.includes(name)) list.push(name);
};

export type CostKind = 'estimated' | 'unpriced' | 'partial';

export interface Cost {
  /** USD, or null when nothing could be priced. */
  value: number | null;
  kind: CostKind;
}

export const emptyUsage = (): TokenUsage => ({
  input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, reasoning: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead,
    reasoning: a.reasoning + b.reasoning,
  };
}
