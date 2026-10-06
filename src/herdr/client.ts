import { execFile } from 'node:child_process';

/** Runs `herdr <args>` and resolves with stdout; rejects with an error carrying stdout/stderr. */
export type HerdrExec = (args: string[], timeoutMs?: number) => Promise<string>;

export const execHerdr: HerdrExec = (args, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    execFile('herdr', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
  });

export class HerdrError extends Error {
  constructor(public code: string, message: string) {
    super(`herdr: ${code} — ${message}`);
  }
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type PromptOutcome = { status: AgentStatus | 'stalled' | 'timeout' };

/** Thin typed wrapper around the herdr CLI (JSON on stdout, JSON errors on stderr). */
export class Herdr {
  constructor(private exec: HerdrExec = execHerdr) {}

  private async json(args: string[], timeoutMs?: number): Promise<any> {
    try {
      return JSON.parse(await this.exec(args, timeoutMs)).result;
    } catch (err: any) {
      const raw = err?.stderr || err?.stdout;
      let parsed: any;
      try {
        parsed = raw ? JSON.parse(raw) : undefined;
      } catch {
        // Not a herdr JSON error.
      }
      if (parsed?.error) throw new HerdrError(parsed.error.code, parsed.error.message ?? '');
      throw err;
    }
  }

  async workspaceCreate(cwd: string, label: string, env: Record<string, string> = {}): Promise<{ workspaceId: string; paneId: string }> {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    const r = await this.json(['workspace', 'create', '--cwd', cwd, '--label', label, ...envArgs, '--no-focus']);
    return { workspaceId: r.workspace.workspace_id, paneId: r.root_pane.pane_id };
  }

  async workspaceClose(workspaceId: string): Promise<void> {
    await this.json(['workspace', 'close', workspaceId]);
  }

  async agentStart(name: string, kind: string, paneId: string, agentArgs: string[]): Promise<void> {
    await this.json(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', '90000', '--', ...agentArgs], 120_000);
  }

  async agentStatus(name: string): Promise<AgentStatus> {
    return (await this.json(['agent', 'get', name])).agent.agent_status;
  }

  /**
   * Submits a prompt and waits until the agent settles (done, idle or blocked). herdr requires a
   * state change within 5 s of submission, which avoids matching a stale "done".
   */
  async promptAndWait(name: string, text: string, timeoutMs: number): Promise<PromptOutcome> {
    const args = ['agent', 'prompt', name, text, '--wait', '--until', 'done', '--until', 'idle', '--until', 'blocked', '--timeout', String(timeoutMs)];
    try {
      const r = await this.json(args, timeoutMs + 30_000);
      return { status: r.agent?.agent_status ?? 'unknown' };
    } catch (err) {
      if (err instanceof HerdrError && err.code === 'agent_prompt_stalled') return { status: 'stalled' };
      if (err instanceof HerdrError && err.code === 'timeout') return { status: 'timeout' };
      throw err;
    }
  }

  /**
   * `recent` also includes the visible screen: herdr 0.8 returns an empty `recent` snapshot for a
   * pane whose output has not scrolled yet.
   */
  async paneRead(paneId: string, source: 'visible' | 'recent' = 'visible'): Promise<string> {
    const visible = await this.exec(['pane', 'read', paneId, '--source', 'visible']);
    if (source === 'visible') return visible;
    return `${await this.exec(['pane', 'read', paneId, '--source', 'recent'])}\n${visible}`;
  }

  async paneSendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.exec(['pane', 'send-keys', paneId, ...keys]);
  }

  async paneSendText(paneId: string, text: string): Promise<void> {
    await this.exec(['pane', 'send-text', paneId, text]);
  }

  /**
   * Waits until the pane shows `match`; false on timeout. Searches the visible screen: the markers
   * waited on are the last output, and herdr 0.8's `recent` snapshot can stay empty.
   */
  async paneWaitOutput(paneId: string, match: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.exec(['pane', 'wait-output', paneId, '--match', match, '--source', 'visible', '--timeout', String(timeoutMs)], timeoutMs + 30_000);
      return true;
    } catch {
      return false;
    }
  }

  async paneRun(paneId: string, command: string): Promise<void> {
    await this.exec(['pane', 'run', paneId, command]);
  }
}
