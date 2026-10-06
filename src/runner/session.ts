import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, Effort, Mode, Prepared, QuotaReading, ScreenProblem } from '../agents/types.js';
import { HerdrError, type Herdr, type PromptOutcome } from '../herdr/client.js';
import type { AgentPaths } from '../paths.js';
import { loadPrices } from '../measure/prices.js';
import { assignPhases, summarize, type PhaseMark, type Summary } from '../measure/aggregate.js';
import { phaseSummaries } from '../measure/summaries.js';
import type { HarnessUse } from '../measure/types.js';
import { jailAvailable, writeJailProfile, type Isolation } from './jail.js';
import { tr } from '../i18n.js';

export interface PhaseRecord {
  name: string;
  startedAt: string;
  endedAt: string;
  outcome: PromptOutcome['status'];
  problem: ScreenProblem | null;
  quotaBefore: QuotaReading | null;
  quotaAfter: QuotaReading | null;
  /** What the agent said at the end of the phase (its own summary). */
  summary?: string;
  /** Fix rounds: ids of the bugs sent in the prompt. */
  bugsSent?: string[];
}

export interface SessionMeasure {
  sessionId: string;
  summary: Summary;
  models: string[];
  /** Agent's own end-of-phase summary, by phase name. */
  phaseSummaries: Record<string, string>;
  harness: HarnessUse;
}

export interface OpenSessionOptions {
  herdr: Herdr;
  adapter: AgentAdapter;
  agentPaths: AgentPaths;
  /** Folder holding the agent's working directory (and its per-job agent home, if any). */
  root: string;
  cwd: string;
  mode: Mode;
  model: string;
  effort: Effort;
  label: string;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Silence after which a stream that ended with « TERMINÉ » counts as finished. */
const SETTLE_MS = 120_000;

async function lastEventAt(file: string): Promise<string | null> {
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n').reverse();
    for (const l of lines) {
      const ts = JSON.parse(l).timestamp_ms;
      if (typeof ts === 'number') return new Date(ts).toISOString();
    }
  } catch {
    // Unreadable stream: the caller falls back to now.
  }
  return null;
}

/**
 * Script mode: cursor-agent sometimes never exits after its last turn (and never writes its final
 * `result` event). The turn is over when the stream has been silent for 2 min, every tool call has
 * completed, and the agent's last words end with « TERMINÉ », as the task rules ask.
 */
export async function streamSettled(file: string, now = Date.now()): Promise<boolean> {
  try {
    if (now - (await stat(file)).mtimeMs < SETTLE_MS) return false;
    const events = (await readFile(file, 'utf8')).trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const open = new Set<string>();
    for (const e of events) if (e.type === 'tool_call') e.subtype === 'started' ? open.add(e.call_id) : open.delete(e.call_id);
    if (open.size || events.some((e) => e.type === 'result')) return false;
    const words = events
      .filter((e) => (e.type === 'thinking' && e.subtype === 'delta') || e.type === 'assistant')
      .slice(-40)
      .map((e) => e.text ?? (e.message?.content ?? []).map((c: any) => c?.text ?? '').join(''))
      .join('');
    const end = words.trim();
    return /termin[ée]e?s?\W*$/i.test(end) && !/(pas|non|jamais)\s+(encore\s+)?termin[ée]e?s?\W*$/i.test(end);
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One interactive agent running in its own herdr workspace. Several prompts can be sent in the
 * same session (build, then fixes); each is recorded as a phase, and the transcript is split by
 * phase start times when measured.
 */
export class AgentSession {
  readonly sessionId = randomUUID();
  readonly agentName = `bm-${this.sessionId.slice(0, 8)}`;
  readonly phases: PhaseRecord[] = [];
  private workspace: { workspaceId: string; paneId: string } | null = null;
  /** Whether the agent's shell runs under the macOS sandbox (see jail.ts). */
  isolation: Isolation = 'none';
  private prepared: Prepared | null = null;
  private log: (msg: string) => void;
  private sleep: (ms: number) => Promise<void>;
  private now: () => string;

  private constructor(private o: OpenSessionOptions) {
    this.log = o.log ?? (() => {});
    this.sleep = o.sleep ?? defaultSleep;
    this.now = () => (o.now ?? (() => new Date()))().toISOString();
  }

  static async open(o: OpenSessionOptions): Promise<AgentSession> {
    const s = new AgentSession(o);
    s.prepared = await o.adapter.prepare({ root: o.root, work: o.cwd, mode: o.mode, userCodexHome: o.agentPaths.codexHome });
    s.workspace = await o.herdr.workspaceCreate(o.cwd, o.label, s.prepared.env);
    if (await jailAvailable()) await s.enterJail();
    // Script-mode agents (Cursor) start with each phase's command, not here.
    if (!o.adapter.headless) {
      await s.start();
      await s.waitUntilReady();
    }
    return s;
  }

  private get pane(): string {
    return this.workspace!.paneId;
  }

  /**
   * Replaces the pane's shell by the same shell under `sandbox-exec`: the agent, started from it,
   * inherits the sandbox. Then proves it: ailovebench's folders must be unreadable from the pane.
   */
  private async enterJail(): Promise<void> {
    const { profile, probe } = await writeJailProfile(this.o.root);
    const id = this.sessionId.slice(0, 8);
    // The marker is split in the typed command, so only the shell's output matches it.
    await this.o.herdr.paneRun(this.pane, `exec /usr/bin/sandbox-exec -f '${profile}' "$SHELL"`);
    await this.o.herdr.paneRun(this.pane, `ls '${probe}' >/dev/null 2>&1 && r=open || r=closed; echo "BM_JA""IL_${id}_$r"`);
    if (!(await this.o.herdr.paneWaitOutput(this.pane, `BM_JAIL_${id}_`, 30_000))) throw new Error(tr('sandbox : le shell isolé ne répond pas', 'sandbox: the isolated shell does not answer'));
    if (!(await this.o.herdr.paneRead(this.pane, 'recent')).includes(`BM_JAIL_${id}_closed`)) {
      throw new Error(tr(`sandbox : l'agent pourrait lire ${probe} (AILOVEBENCH_NO_SANDBOX=1 pour lancer sans isolation)`, `sandbox: the agent could read ${probe} (AILOVEBENCH_NO_SANDBOX=1 to run without isolation)`));
    }
    await this.o.herdr.paneRun(this.pane, 'clear');
    this.isolation = 'sandbox';
    this.log(tr('isolation : sandbox macOS (seul le dossier du job est lisible côté ailovebench)', "isolation: macOS sandbox (only the job's folder is readable on ailovebench's side)"));
  }

  /** A fresh workspace's shell needs a moment before herdr accepts an agent in it (`agent_pane_busy`). */
  private async start(): Promise<void> {
    const args = this.o.adapter.launchArgs({ mode: this.o.mode, model: this.o.model, sessionId: this.sessionId, work: this.o.cwd, effort: this.o.effort });
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.o.herdr.agentStart(this.agentName, this.o.adapter.kind, this.pane, args);
      } catch (err) {
        if (!(err instanceof HerdrError && err.code === 'agent_pane_busy') || attempt >= 15) throw err;
        await this.sleep(2000);
      }
    }
  }

  private async waitUntilReady(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const screen = await this.o.herdr.paneRead(this.pane);
      const keys = this.o.adapter.startupKeys(screen);
      if (keys) {
        this.log(tr('question de démarrage détectée (confiance du dossier) : réponse automatique', 'startup question detected (folder trust): answered automatically'));
        await this.o.herdr.paneSendKeys(this.pane, keys);
        await this.sleep(2000);
        continue;
      }
      if (this.o.adapter.isReady(screen)) return;
      await this.sleep(1000);
    }
    throw new Error(tr("l'agent n'est pas prêt après 60 s", 'the agent is not ready after 60 s'));
  }

  /** Script mode: the agent's own session id, learnt from its first phase, for `--resume`. */
  private headlessSession: string | null = null;
  private headlessFiles: Array<{ phase: string; file: string }> = [];

  /**
   * Script mode (Cursor): one command per phase in the herdr pane, output streamed to a file, end
   * detected by a marker unique to the phase (older markers stay in the scrollback).
   */
  private async promptHeadless(name: string, text: string, timeoutMin: number): Promise<PhaseRecord> {
    const h = this.o.adapter.headless!;
    const dir = path.join(this.o.root, 'phases');
    await mkdir(dir, { recursive: true });
    const promptFile = path.join(dir, `${name}.prompt.md`);
    const outFile = path.join(dir, `${name}.jsonl`);
    await writeFile(promptFile, text);
    const marker = `BM_DONE_${name.replace(/[^a-z0-9]/gi, '_')}_${this.sessionId.slice(0, 6)}`;
    const half = Math.floor(marker.length / 2);
    const cmd = h.command({ model: this.o.model, sessionId: this.headlessSession, promptFile, outFile });
    const startedAt = this.now();
    this.log(`${name} : ${tr('commande lancée', 'command started')} (timeout ${timeoutMin} min)`);
    await this.o.herdr.paneRun(this.pane, `cd '${this.o.cwd}' && ${cmd}; echo "${marker.slice(0, half)}""${marker.slice(half)}"`);
    const deadline = Date.now() + timeoutMin * 60_000;
    let finished = false;
    let settled = false;
    while (!finished && !settled && Date.now() < deadline) {
      finished = await this.o.herdr.paneWaitOutput(this.pane, marker, Math.min(30_000, Math.max(1000, deadline - Date.now())));
      if (!finished) settled = await streamSettled(outFile);
    }
    if (!finished) await this.o.herdr.paneSendKeys(this.pane, ['ctrl+c']).catch(() => {});
    // The agent's own last turn may be taken from the end of the stream, without Cursor's final event.
    const endedAt = settled ? ((await lastEventAt(outFile)) ?? this.now()) : this.now();
    const r = await h.readPhase(outFile);
    this.headlessSession ??= r.sessionId;
    this.headlessFiles.push({ phase: name, file: outFile });
    const outcome: PhaseRecord['outcome'] = finished || settled ? 'done' : 'timeout';
    if (settled) this.log(`${name} : ${tr("l'agent a fini (« TERMINÉ ») mais cursor-agent n'a pas rendu la main : arrêté, tokens de ce tour non mesurés", 'the agent finished (« TERMINÉ ») but cursor-agent did not exit: stopped, tokens of this turn not measured')}`);
    this.log(`${name} : ${outcome}${finished && r.problem ? ` · ${r.problem.kind} : ${r.problem.detail}` : ''}`);
    const phase = { name, startedAt, endedAt, outcome, problem: finished ? r.problem : null, quotaBefore: null, quotaAfter: null };
    this.phases.push(phase);
    return phase;
  }

  /** Sends one prompt, waits for the agent to settle, and records the phase with quota around it. */
  async prompt(name: string, text: string, timeoutMin: number): Promise<PhaseRecord> {
    if (this.o.adapter.headless) return this.promptHeadless(name, text, timeoutMin);
    const quotaBefore = await this.readQuota();
    const startedAt = this.now();
    this.log(`${name} : ${tr('prompt envoyé', 'prompt sent')} (timeout ${timeoutMin} min)`);
    const outcome = await this.o.herdr.promptAndWait(this.agentName, text, timeoutMin * 60_000);
    const endedAt = this.now();
    const problem = this.o.adapter.screenProblem(await this.o.herdr.paneRead(this.pane, 'recent'));
    this.log(`${name} : ${outcome.status}${problem ? ` · ${problem.kind} : ${problem.detail}` : ''}`);
    const quotaAfter = outcome.status === 'done' || outcome.status === 'idle' ? await this.readQuota() : null;
    const phase = { name, startedAt, endedAt, outcome: outcome.status, problem, quotaBefore, quotaAfter };
    this.phases.push(phase);
    return phase;
  }

  /** Current subscription usage, read on the agent's own screen (no prompt sent, no tokens). */
  quota(): Promise<QuotaReading | null> {
    return this.readQuota();
  }

  /** Opens the agent's usage screen, reads it, closes it. Never while the agent works. */
  private async readQuota(): Promise<QuotaReading | null> {
    const { herdr, adapter } = this.o;
    await herdr.paneSendText(this.pane, adapter.usageCommand);
    await this.sleep(700);
    await herdr.paneSendKeys(this.pane, ['enter']);
    let reading: QuotaReading | null = null;
    for (let i = 0; i < 10 && !reading; i++) {
      await this.sleep(1000);
      reading = adapter.parseUsage(await herdr.paneRead(this.pane));
    }
    if (adapter.usageDismissKeys.length) await herdr.paneSendKeys(this.pane, adapter.usageDismissKeys);
    await this.sleep(1000);
    return reading;
  }

  /** Tokens and cost of the whole session, split by phase. */
  async measure(): Promise<SessionMeasure | null> {
    if (this.o.adapter.headless) {
      if (!this.headlessFiles.length) return null;
      const parsed = await this.o.adapter.headless.parsePhases(this.headlessFiles, this.o.model);
      const marks: PhaseMark[] = this.phases.map((p) => ({ name: p.name, at: p.startedAt }));
      return {
        sessionId: parsed.sessionId ?? this.sessionId,
        summary: summarize(loadPrices(), assignPhases(parsed.requests, marks)),
        models: [this.o.model],
        phaseSummaries: phaseSummaries(parsed.messages, this.phases),
        harness: parsed.harness,
      };
    }
    const file = await this.o.adapter
      .locateTranscript({ work: this.o.cwd, sessionId: this.sessionId, mode: this.o.mode, env: this.prepared?.env ?? {}, paths: this.o.agentPaths })
      .catch(() => null);
    if (!file) return null;
    const parsed = await this.o.adapter.parseTranscript(file);
    const marks: PhaseMark[] = this.phases.map((p) => ({ name: p.name, at: p.startedAt }));
    return {
      sessionId: parsed.sessionId ?? this.sessionId,
      summary: summarize(loadPrices(), assignPhases(parsed.requests, marks)),
      models: [...new Set(parsed.requests.map((r) => r.model))],
      phaseSummaries: phaseSummaries(parsed.messages, this.phases),
      harness: parsed.harness,
    };
  }

  async close(keepWorkspace = false): Promise<void> {
    if (this.workspace && !keepWorkspace) await this.o.herdr.workspaceClose(this.workspace.workspaceId).catch(() => {});
    await this.prepared?.cleanup().catch((err) => this.log(`${tr('nettoyage', 'cleanup')} : ${err instanceof Error ? err.message : err}`));
  }
}
