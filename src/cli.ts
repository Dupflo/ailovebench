#!/usr/bin/env node
import { checkDetail, checkLabel } from './checks/types.js';
import { bugTitle } from './qa/bugs.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { defaultAgentPaths } from './paths.js';
import { detectMachine } from './detect/machine.js';
import { detectAgents } from './detect/agents.js';
import { detectClaudePlan, detectCodexPlan, detectCursorPlan } from './detect/subscriptions.js';
import { locateSession } from './measure/locate.js';
import { parseClaudeSession } from './measure/transcripts/claude.js';
import { parseCodexRollout } from './measure/transcripts/codex.js';
import { loadPrices } from './measure/prices.js';
import { assignPhases, summarize, type PhaseMark } from './measure/aggregate.js';
import { Herdr } from './herdr/client.js';
import { claudeAdapter, resolveClaudeModel } from './agents/claude.js';
import { codexAdapter } from './agents/codex.js';
import { adapterFor, pickTester } from './agents/index.js';
import { modeLabel } from './ui/labels.js';
import { loadTask } from './catalog/load.js';
import { newRunId } from './runner/sandbox.js';
import { runJob, type JobResult } from './runner/job.js';
import { runChecks, type ChecksRun } from './checks/run.js';
import { readFile, writeFile } from 'node:fs/promises';
import { migrateLegacyHome, runsRoot } from './paths.js';
import { commandVersion } from './detect/exec.js';
import { normalizeMode, type Mode, type QuotaReading } from './agents/types.js';
import { tr, dec } from './i18n.js';
import { DISCLAIMER, pricesLine, fmtCost, fmtDuration, fmtTokens, fmtUsage, table } from './format.js';

const HELP = (): string => tr(`ailovebench — Arrêtez de croire les benchmarks des éditeurs d'IA. Benchez vous-même.

Utilisation :
  ailovebench
      Interactif : choix des modèles, des projets, des modes (sans / avec harness), vérification du quota, run, rapport.

  ailovebench bench --models <a,b> --tasks <x,y|all> [--modes bare,harness] [--tester auto|none|<modèle>]
                    [--effort medium] [--sequential] [--modes-together] [--max-fix 3] [--no-serve]
                    [--into <id-du-run>]
      Pareil sans questions : lance les vagues, écrit le rapport (HTML + PDF), puis sert chaque
      projet livré sur son propre port, plus le rapport, jusqu'à Ctrl+C (--no-serve : quitte aussitôt).
      --into ajoute les jobs à un run existant (les jobs déjà faits sont ignorés).

  ailovebench serve <dossier-du-run>
      Sert les projets et le rapport d'un run passé (ouvre le rapport), jusqu'à Ctrl+C.
      AILOVEBENCH_NO_OPEN=1 garde le navigateur fermé.

  ailovebench delete <id-du-run> [--yes]
      Supprime un run (projets générés, captures, rapport), après confirmation.

  ailovebench report <dossier-du-run> [--no-pdf]
      (Re)construit le rapport en slides d'un run (HTML + PDF).

  ailovebench detect [--json]
      Machine, agents installés, modèles disponibles, abonnements détectés.

  ailovebench run --task <id> --model <modèle> [--mode bare|harness] [--tester auto|none|<modèle>] [--max-fix 3] [--keep]
      Lance une tâche avec un modèle dans un bac à sable herdr et écrit job.json.
      Les modèles Claude (claude-*, opus, sonnet, haiku, fable) tournent dans Claude Code, les autres dans Codex.
      --mode bare     sans harness : ni instructions, ni skills, ni plugins, ni hooks, ni MCP (par défaut)
      --mode harness  avec harness : la configuration d'agent de l'utilisateur
      --tester        testeur en boîte noire (par défaut : un modèle de l'autre fournisseur ; none = checks seulement)
      --effort        effort de raisonnement de tous les agents, testés et testeur : low | medium | high (medium par défaut)
      --max-fix       tours de correction renvoyés à la même session quand des bugs sont confirmés (3 par défaut)
      --keep          garde l'espace de travail herdr ouvert après

  ailovebench check <dossier-du-job>
      Relance les checks automatiques de la tâche sur un job terminé et met à jour son job.json.

  ailovebench measure <id-de-session | transcript.jsonl> [options]
      Tokens, coût équivalent API et durée d'une session Claude Code ou Codex.
      --limit <n>           seulement les n premières requêtes (ordre chronologique)
      --mark <phase=ISO>    début d'une phase (répétable), ex. --mark build=2026-10-01T10:00:00Z
      --json                sortie lisible par une machine
`, `ailovebench — Stop trusting AI companies' benchmarks. Bench yourself.

Usage:
  ailovebench
      Interactive: pick models, projects, modes (without / with harness), check the quota, run, report.

  ailovebench bench --models <a,b> --tasks <x,y|all> [--modes bare,harness] [--tester auto|none|<model>]
                    [--effort medium] [--sequential] [--modes-together] [--max-fix 3] [--no-serve]
                    [--into <run-id>]
      Same without questions: runs the waves, writes the report (HTML + PDF), then serves every
      delivered project on its own port, plus the report, until Ctrl+C (--no-serve: exit at once).
      --into adds the jobs to an existing run (jobs already done are skipped).

  ailovebench serve <run-folder>
      Serves the projects and the report of a past run (opens the report), until Ctrl+C.
      AILOVEBENCH_NO_OPEN=1 keeps the browser closed.

  ailovebench delete <run-id> [--yes]
      Deletes a run (generated projects, captures, report), after confirmation.

  ailovebench report <run-folder> [--no-pdf]
      (Re)builds the slides report of a run (HTML + PDF).

  ailovebench detect [--json]
      Machine, installed agents, available models, detected subscriptions.

  ailovebench run --task <id> --model <model> [--mode bare|harness] [--tester auto|none|<model>] [--max-fix 3] [--keep]
      Runs one task with one model in a herdr sandbox and writes job.json.
      Claude models (claude-*, opus, sonnet, haiku, fable) run in Claude Code, others in Codex.
      --mode bare     without harness: no instructions, skills, plugins, hooks, MCP (default)
      --mode harness  with harness: the user's own agent setup
      --tester        black-box tester (default: the other provider's model; none = checks only)
      --effort        reasoning effort for every agent, tested and tester: low | medium | high (default medium)
      --max-fix       fix rounds sent back to the same session when bugs are confirmed (default 3)
      --keep          keep the herdr workspace open afterwards

  ailovebench check <job-folder>
      Re-runs the task's automatic checks on a finished job and updates its job.json.

  ailovebench measure <session-id | transcript.jsonl> [options]
      Tokens, API-equivalent cost and duration of one Claude Code or Codex session.
      --limit <n>           only the first n requests (time order)
      --mark <phase=ISO>    start of a phase (repeatable), e.g. --mark build=2026-10-01T10:00:00Z
      --json                machine-readable output
`);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const moved = migrateLegacyHome();
    if (moved) console.error(tr(`Le projet s'appelle désormais ailovebench : vos runs sont dans ${moved} (lien laissé à l'ancien emplacement).`, `This project is now called ailovebench: your runs are in ${moved} (a link is left at the old location).`));
  } catch (err) {
    console.error(tr(`Migration de ~/.benchmyself impossible : ${err instanceof Error ? err.message : err}`, `Could not migrate ~/.benchmyself: ${err instanceof Error ? err.message : err}`));
  }
  switch (command) {
    case 'detect':
      return detect(rest);
    case 'measure':
      return measure(rest);
    case 'run':
      return runCommand(rest);
    case 'check':
      return checkCommand(rest);
    case undefined:
      if (process.stdin.isTTY) return (await import('./wizard.js')).wizard();
      process.stdout.write(HELP());
      return 0;
    case 'bench':
      return benchCommand(rest);
    case 'report':
      return reportCommand(rest);
    case 'delete': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        process.stderr.write(tr(`Il manque l'identifiant du run (ex. 20261001-153224).\n`, `Missing run id (e.g. 20261001-153224).\n`));
        return 1;
      }
      if (!rest.includes('--yes')) {
        const { confirm } = await import('@inquirer/prompts');
        if (!(await confirm({ message: tr(`Supprimer définitivement le bench ${id} ?`, `Permanently delete bench ${id}?`), default: false }))) return 0;
      }
      await (await import('./report/data.js')).deleteRun(runsRoot(), id);
      console.log(tr(`Bench ${id} supprimé.`, `Bench ${id} deleted.`));
      return 0;
    }
    case 'serve':
      if (!rest[0]) {
        process.stderr.write(`${tr('Il manque le dossier du run.', 'Missing run folder.')}\n\n${HELP()}`);
        return 1;
      }
      await (await import('./runner/showcase.js')).presentRun(path.resolve(rest[0]));
      return 0;
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP());
      return 0;
    default:
      process.stderr.write(`${tr(`Commande inconnue : ${command}`, `Unknown command: ${command}`)}\n\n${HELP()}`);
      return 1;
  }
}

async function detect(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const paths = defaultAgentPaths();
  const [machine, agents, claudePlan, codexPlan, cursorPlan] = await Promise.all([
    detectMachine(),
    detectAgents(paths.codexHome),
    detectClaudePlan(paths.claudeJson),
    detectCodexPlan(paths.codexHome),
    detectCursorPlan(),
  ]);
  const plans = { claude: claudePlan, codex: codexPlan, cursor: cursorPlan };

  if (values.json) {
    process.stdout.write(JSON.stringify({ machine, agents, plans }, null, 2) + '\n');
    return 0;
  }

  const gpus = machine.gpus.map((g) => (g.vramGb ? `${g.name} (${g.vramGb} ${tr('Go', 'GB')})` : g.name)).join(', ') || tr('inconnu', 'unknown');
  console.log(tr(`Machine  ${machine.os} · ${machine.cpu} (${machine.cores} cœurs) · ${machine.ramGb} Go RAM`, `Machine  ${machine.os} · ${machine.cpu} (${machine.cores} cores) · ${machine.ramGb} GB RAM`));
  console.log(`GPU      ${gpus}`);
  console.log(`Node ${machine.node} · herdr ${machine.herdr ?? tr('non installé ⚠️ (requis pour lancer des runs)', 'not installed ⚠️ (required to run benches)')}`);
  console.log(`${pricesLine()}\n`);

  console.log(
    table(
      ['Agent', tr('Statut', 'Status'), 'Version', tr('Abonnement', 'Subscription'), tr('Modèles', 'Models')],
      agents.map((a) => {
        const plan = a.id === 'claude' || a.id === 'codex' || a.id === 'cursor' ? plans[a.id].label : '—';
        const status = !a.installed ? tr('non installé', 'not installed') : a.supported ? tr('installé', 'installed') : tr('installé (pas encore pris en charge)', 'installed (not supported yet)');
        return [a.label, status, a.version ?? '—', a.installed ? plan : '—', a.installed ? a.models.join(', ') || '—' : `→ ${a.installHint}`];
      }),
    ),
  );
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      task: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string', default: 'bare' },
      keep: { type: 'boolean' },
      tester: { type: 'string', default: 'auto' },
      effort: { type: 'string', default: 'medium' },
      'max-fix': { type: 'string', default: '3' },
    },
  });
  if (!values.task || !values.model) {
    process.stderr.write(`${tr('--task et --model sont requis.', '--task and --model are required.')}\n\n${HELP()}`);
    return 1;
  }
  if (!['low', 'medium', 'high'].includes(values.effort!)) {
    process.stderr.write(tr(`--effort doit valoir low, medium ou high.\n`, `--effort must be low, medium or high.\n`));
    return 1;
  }
  const mode = normalizeMode(values.mode!);
  if (!mode) {
    process.stderr.write(tr(`--mode doit valoir bare ou harness.\n`, `--mode must be bare or harness.\n`));
    return 1;
  }
  if (!(await commandVersion('herdr'))) {
    process.stderr.write(tr('herdr est introuvable : il est requis pour piloter les agents.\n', 'herdr not found: it is required to drive the agents.\n'));
    return 1;
  }
  const task = await loadTask(values.task);
  const model = resolveClaudeModel(values.model);
  const adapter = adapterFor(model);
  const tester = await pickTester(values.tester, adapter.kind, (m) => console.log(`⚠️ ${m}`));
  const runId = newRunId();
  console.log(`Run ${runId} · ${task.id} (${task.title}) · ${adapter.kind} ${model} · ${modeLabel(mode)} · effort ${values.effort}`);
  console.log(`${tr('Recette', 'Testing')} : ${tester ? `${tester.adapter.kind} ${tester.model}` : tr('checks automatiques seulement', 'automatic checks only')}`);

  const result = await runJob({
    runId,
    runsRoot: runsRoot(),
    task,
    model,
    mode,
    herdr: new Herdr(),
    adapter,
    tester,
    effort: values.effort as 'low' | 'medium' | 'high',
    maxFixRounds: Number(values['max-fix']),
    agentPaths: defaultAgentPaths(),
    keepWorkspace: values.keep,
    log: (m) => console.log(`  · ${m}`),
  });

  const build = result.phases[0];
  const ms = Date.parse(result.endedAt) - Date.parse(result.startedAt);
  console.log(`\n${tr('Statut  ', 'Status  ')} ${result.status}`);
  console.log(`${tr('Durée   ', 'Duration')} ${fmtDuration(ms)}${build ? ` (build${tr(' :', ':')} ${fmtDuration(Date.parse(build.endedAt) - Date.parse(build.startedAt))})` : ''}`);
  if (result.measure) {
    console.log(`Tokens   ${fmtUsage(result.measure.total.usage)}`);
    console.log(`${tr('Coût    ', 'Cost    ')} ${fmtCost(result.measure.total.cost)}`);
  }
  const q = (r: QuotaReading | null) => (r ? `${r.window5hPct ?? '?'} % (5 h) · ${r.weekPct ?? '?'} % (${tr('semaine', 'week')})` : tr('non lu', 'not read'));
  if (build) console.log(`Quota    ${tr('avant', 'before')} ${q(build.quotaBefore)} → ${tr('après', 'after')} ${q(build.quotaAfter)}`);
  for (const qa of result.qa) {
    console.log('');
    printChecks(qa);
  }
  if (result.tester) {
    console.log(`\n${tr('Recette', 'Testing')} ${result.tester.agent} ${result.tester.model}`);
    for (const s of result.tester.strengths) console.log(`  + ${s}`);
    for (const w of result.tester.weaknesses) console.log(`  − ${w}`);
    for (const n of result.tester.notes) console.log(`  ⚠️ ${n}`);
  }
  if (result.bugs.length) {
    console.log('');
    console.log(table(['Bug', 'Source', tr('Statut', 'Status'), tr('Titre', 'Title')], result.bugs.map((b) => [b.id, b.source === 'check' ? 'check' : tr('testeur', 'tester'), b.status + (b.fixedInRound ? ` (${tr('tour', 'round')} ${b.fixedInRound})` : ''), bugTitle(b)])));
  }
  if (result.split) {
    const c = (v: number | null) => (v === null ? tr('non chiffré', 'not priced') : `${dec(v.toFixed(2))} $`);
    console.log(`\n${tr('Coût initial  ', 'Initial cost  ')} ${c(result.split.initial.costUsd)} · ${fmtDuration(result.split.initial.timeMs)}`);
    console.log(`${tr('Reprise       ', 'Rework        ')} ${c(result.split.rework.costUsd)} · ${fmtDuration(result.split.rework.timeMs)}${result.split.reworkShare !== null ? ` (+${Math.round(result.split.reworkShare * 100)} %)` : ''}`);
    console.log(`${tr("Jusqu'au produit final ", 'Up to final product    ')} ${c(result.split.total.costUsd)} · ${fmtDuration(result.split.total.timeMs)}`);
  }
  const VERDICT = {
    works: tr('✅ fonctionne', '✅ works'),
    works_with_bugs: tr('⚠️ fonctionne avec bugs restants', '⚠️ works with remaining bugs'),
    broken: tr('❌ ne fonctionne pas', '❌ does not work'),
    abandoned: tr('⏸ abandonné', '⏸ abandoned'),
  };
  if (result.verdict) console.log(`Verdict  ${VERDICT[result.verdict]}`);
  console.log(`${tr('Projet  ', 'Project ')} ${result.workDir}`);
  console.log(`${tr('Résultat', 'Result  ')} ${path.join(path.dirname(result.workDir), 'job.json')}`);
  console.log(`\n${DISCLAIMER}\n${pricesLine()}`);
  return result.status === 'completed' ? 0 : 2;
}

async function benchCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      models: { type: 'string' },
      tasks: { type: 'string' },
      modes: { type: 'string', default: 'bare' },
      tester: { type: 'string', default: 'auto' },
      effort: { type: 'string', default: 'medium' },
      'max-fix': { type: 'string', default: '3' },
      sequential: { type: 'boolean' },
      'modes-together': { type: 'boolean' },
      'no-serve': { type: 'boolean' },
      into: { type: 'string' },
    },
  });
  if (!values.models || !values.tasks) {
    process.stderr.write(`${tr('--models et --tasks sont requis.', '--models and --tasks are required.')}\n\n${HELP()}`);
    return 1;
  }
  const { listTasks } = await import('./catalog/load.js');
  const { userCatalogPath } = await import('./catalog/idea.js');
  const { buildReport } = await import('./report/build.js');
  const { reportToPdf } = await import('./report/pdf.js');
  const { catalogPath } = await import('./paths.js');
  const tasks = values.tasks === 'all'
    ? (await listTasks([catalogPath()])).map((t) => t.id)
    : values.tasks.split(',').map((t) => t.trim());
  const runId = values.into ?? newRunId();
  const root = runsRoot();
  console.log(values.into ? tr(`Ajout au run ${runId}`, `Adding to run ${runId}`) : `Run ${runId}`);
  const { runBenchLive } = await import('./runner/live.js');
  await runBenchLive({
    runId, runsRoot: root, append: !!values.into, herdr: new Herdr(), agentPaths: defaultAgentPaths(), catalogRoots: [userCatalogPath()],
    plan: {
      tasks,
      models: values.models.split(',').map((m) => m.trim()),
      modes: values.modes!.split(',').map((m) => normalizeMode(m.trim())).filter((m): m is Mode => m !== null),
      effort: values.effort as 'low' | 'medium' | 'high',
      tester: values.tester!,
      maxFixRounds: Number(values['max-fix']),
      sequential: values.sequential ?? false,
      modesTogether: values['modes-together'] ?? false,
    },
  });
  if (values['no-serve']) {
    const html = await buildReport(path.join(root, runId));
    console.log(`\n${tr('Rapport :', 'Report: ')} ${html}\nPDF${tr('     :', ':    ')} ${await reportToPdf(html)}`);
    return 0;
  }
  await (await import('./runner/showcase.js')).presentRun(path.join(root, runId));
  return 0;
}

async function reportCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'no-pdf': { type: 'boolean' } },
  });
  if (!positionals[0]) {
    process.stderr.write(`${tr('Il manque le dossier du run.', 'Missing run folder.')}\n\n${HELP()}`);
    return 1;
  }
  const { buildReport } = await import('./report/build.js');
  const html = await buildReport(path.resolve(positionals[0]));
  console.log(`${tr('Rapport :', 'Report: ')} ${html}`);
  if (!values['no-pdf']) console.log(`PDF${tr('     :', ':    ')} ${await (await import('./report/pdf.js')).reportToPdf(html)}`);
  return 0;
}

function printChecks(qa: ChecksRun): void {
  const icon = { pass: '✅', fail: '❌', skip: '⏭️', error: '⚠️' } as const;
  console.log(
    table(
      ['', 'Check', tr('Valeur', 'Value'), tr('Détail', 'Detail')],
      qa.results.map((r) => [icon[r.status], checkLabel(r), r.value !== undefined ? String(r.value) : '', (checkDetail(r) ?? '').split('\n')[0]!.slice(0, 80)]),
    ),
  );
  console.log(tr(`\nQA round ${qa.round} : ${qa.passed} ok · ${qa.failed} en échec`, `\nQA round ${qa.round}: ${qa.passed} passed · ${qa.failed} failed`));
}

async function checkCommand(args: string[]): Promise<number> {
  const dir = args[0];
  if (!dir) {
    process.stderr.write(`${tr('Il manque le dossier du job.', 'Missing job folder.')}\n\n${HELP()}`);
    return 1;
  }
  const jobFile = path.join(dir, 'job.json');
  const job: JobResult = JSON.parse(await readFile(jobFile, 'utf8'));
  const task = await loadTask(job.task.id);
  console.log(`Checks · ${job.id}`);
  const qa = await runChecks(task, dir, job.workDir, 0);
  // A re-check re-measures the product, not the run: the timeline keeps the original QA slot.
  const previous = job.qa?.find((q) => q.round === 0);
  if (previous) Object.assign(qa, { startedAt: previous.startedAt, endedAt: previous.endedAt });
  job.qa = [qa, ...(job.qa ?? []).filter((q) => q.round !== 0)];
  if (task.knownBugs.length) {
    const { knownBugStatus } = await import('./qa/known-bugs.js');
    job.knownBugs = knownBugStatus(task.knownBugs, qa.baseline, job.qa.at(-1));
  }
  await writeFile(jobFile, JSON.stringify(job, null, 2) + '\n');
  printChecks(qa);
  return qa.failed ? 2 : 0;
}

async function measure(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, limit: { type: 'string' }, mark: { type: 'string', multiple: true } },
  });
  const ref = positionals[0];
  if (!ref) {
    process.stderr.write(`${tr("Il manque l'id ou le chemin de la session.", 'Missing session id or path.')}\n\n${HELP()}`);
    return 1;
  }
  const located = await locateSession(ref, defaultAgentPaths());
  if (!located) {
    process.stderr.write(tr(`Session introuvable : ${ref}\n`, `Session not found: ${ref}\n`));
    return 1;
  }

  let session;
  if (located.agent === 'cursor') {
    // The model id is the bench's (job.json next to phases/), Cursor's stream only shows its label.
    const job = JSON.parse(await readFile(path.join(path.dirname(path.dirname(located.file)), 'job.json'), 'utf8').catch(() => '{}'));
    const { parseCursorStreams } = await import('./measure/transcripts/cursor.js');
    const { cursorPriceModel } = await import('./agents/cursor.js');
    session = await parseCursorStreams([{ phase: path.basename(located.file, '.jsonl'), file: located.file }], cursorPriceModel(job.model ?? 'unknown'));
  } else {
    session = located.agent === 'claude' ? await parseClaudeSession(located.file) : await parseCodexRollout(located.file);
  }
  let requests = session.requests;
  if (values.limit) requests = requests.slice(0, Number(values.limit));

  const marks: PhaseMark[] = (values.mark ?? []).map((m) => {
    const i = m.indexOf('=');
    return { name: m.slice(0, i), at: m.slice(i + 1) };
  });
  const summary = summarize(loadPrices(), assignPhases(requests, marks));
  const start = requests[0]?.timestamp ?? session.startedAt;
  const end = requests.at(-1)?.timestamp ?? session.endedAt;
  const durationMs = start && end ? Date.parse(end) - Date.parse(start) : null;

  if (values.json) {
    process.stdout.write(
      JSON.stringify({ agent: session.agent, sessionId: session.sessionId, file: located.file, start, end, durationMs, summary }, null, 2) + '\n',
    );
    return 0;
  }

  console.log(`Session  ${session.agent} · ${session.sessionId ?? located.file}`);
  console.log(`${tr('Durée   ', 'Duration')} ${durationMs !== null ? fmtDuration(durationMs) : tr('inconnue', 'unknown')} (${start} → ${end})`);
  console.log(`${tr('Requêtes', 'Requests')} ${summary.total.requests}`);
  console.log(`Tokens   ${fmtUsage(summary.total.usage)}`);
  console.log(`${tr('Coût    ', 'Cost    ')} ${fmtCost(summary.total.cost)}\n`);

  console.log(
    table(
      [tr('Modèle', 'Model'), tr('Requêtes', 'Requests'), tr('Sortie', 'Output'), tr('Lecture cache', 'Cache read'), tr('Coût', 'Cost')],
      summary.byModel.map((m) => [m.model, String(m.requests), fmtTokens(m.usage.output), fmtTokens(m.usage.cacheRead), fmtCost(m.cost)]),
    ),
  );
  if (marks.length) {
    console.log('');
    console.log(
      table(
        ['Phase', tr('Requêtes', 'Requests'), tr('Sortie', 'Output'), tr('Coût', 'Cost')],
        summary.byPhase.map((p) => [p.phase, String(p.requests), fmtTokens(p.usage.output), fmtCost(p.cost)]),
      ),
    );
  }
  if (summary.unpricedModels.length) console.log(tr(`\nTokens non chiffrés (pas de prix) : ${summary.unpricedModels.join(', ')}`, `\nUnpriced tokens (no price): ${summary.unpricedModels.join(', ')}`));
  console.log(`\n${DISCLAIMER}\n${pricesLine()}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  },
);
