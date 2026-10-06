import { checkbox, confirm, input, select, Separator } from '@inquirer/prompts';
import { catalogPath, defaultAgentPaths, runsRoot } from './paths.js';
import { detectAgents, type AgentInfo } from './detect/agents.js';
import { listTasks } from './catalog/load.js';
import { createIdeaTask, userCatalogPath } from './catalog/idea.js';
import { adapterFor, DEFAULT_TESTER } from './agents/index.js';
import { planWaves, type BenchPlan } from './runner/bench.js';
import { runBenchLive } from './runner/live.js';
import { presentRun } from './runner/showcase.js';
import { deleteRun, listRecentRuns, type RunSummary } from './report/data.js';
import { modelColor } from './ui/colors.js';
import { estimateNeed, quotaHistory, quotaVerdict, type PlannedJob } from './runner/quota-plan.js';
import { probeQuota } from './runner/probe.js';
import { newRunId } from './runner/sandbox.js';
import { Herdr } from './herdr/client.js';
import { loadPrices, normalizeModelId } from './measure/prices.js';
import { commandVersion } from './detect/exec.js';
import { DISCLAIMER, pricesLine } from './format.js';
import { modelLabel } from './ui/model-label.js';
import type { Mode } from './agents/types.js';
import { dec, tr } from './i18n.js';

const PRESELECTED = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra']);
const label = modelLabel;

/** `ailovebench` with no argument: pick models, projects and modes, check the quota, run, report. */
export async function wizard(): Promise<number> {
  console.log(tr("\nailovebench — Arrêtez de croire les benchmarks des éditeurs d'IA. Benchez vous-même.\n", "\nailovebench — Stop trusting AI companies' benchmarks. Bench yourself.\n"));
  if (!(await commandVersion('herdr'))) {
    console.log(tr('herdr est introuvable : il est requis pour piloter les agents.', 'herdr not found: it is required to drive the agents.'));
    return 1;
  }
  for (;;) {
    const code = await mainMenu();
    if (code !== BACK) return code;
  }
}

async function mainMenu(): Promise<number | typeof BACK> {
  const start = await select({
    message: tr('Que veux-tu faire ?', 'What do you want to do?'),
    choices: [
      { name: tr('Démarrer un nouveau bench', 'Start a new bench'), value: 'new' },
      { name: tr('Ajouter un bench à un test existant (nouveaux modèles, projets ou modes dans le même rapport)', 'Add to an existing bench (new models, projects or modes in the same report)'), value: 'add' },
      { name: tr('Consulter un bench récent', 'Open a recent bench'), value: 'recent' },
      { name: tr('Supprimer un bench', 'Delete a bench'), value: 'delete' },
      { name: tr('Quitter', 'Quit'), value: 'quit' },
    ],
  });
  if (start === 'quit') return 0;
  if (start === 'delete') {
    const runId = await pickRun(tr('Bench à supprimer', 'Bench to delete'));
    if (!runId) return BACK;
    const run = (await listRecentRuns(runsRoot(), 1000)).find((r) => r.runId === runId);
    const what = run ? `${run.jobs} job(s) · ${run.tasks.join(', ')} · ${run.models.map(label).join(', ')}` : runId;
    const sure = await confirm({ message: tr(`Supprimer définitivement ce bench (${what}) ? Projets générés, captures et rapport seront effacés.`, `Permanently delete this bench (${what})? Generated projects, captures and report will be erased.`), default: false });
    if (sure) {
      await deleteRun(runsRoot(), runId);
      console.log(tr(`Bench ${runId} supprimé.`, `Bench ${runId} deleted.`));
    } else console.log(tr('Rien n\'a été supprimé.', 'Nothing was deleted.'));
    return 0;
  }
  if (start === 'recent') {
    const runId = await pickRun(tr('Bench à consulter', 'Bench to open'));
    if (!runId) return BACK;
    await presentRun(`${runsRoot()}/${runId}`);
    return 0;
  }

  const paths = defaultAgentPaths();
  const agents = await detectAgents(paths.codexHome);
  const root = runsRoot();

  let runId = newRunId();
  let existing: RunSummary | null = null;
  if (start === 'add') {
    const picked = await pickRun(tr('Bench à compléter', 'Bench to extend'));
    if (!picked) return BACK;
    runId = picked;
    existing = (await listRecentRuns(root, 1000)).find((r) => r.runId === picked) ?? null;
    if (existing) {
      console.log(`\n${tr('Ce bench contient déjà :', 'This bench already has:')} ${existing.tasks.join(', ')} · ${existing.models.map((m) => modelColor(m)(label(m))).join(', ')}`);
      console.log(tr('Les combinaisons déjà faites seront ignorées.\n', 'Combinations already done will be skipped.\n'));
    }
  }

  let choice: BenchChoice | typeof BACK | null;
  for (;;) {
    choice = await chooseBench(agents, existing);
    if (choice === BACK) return BACK;
    if (!choice) return 0;
    const already = existing ? await doneJobs(`${root}/${runId}`) : new Set<string>();
    const decision = await recap(choice.plan, root, paths, already);
    if (decision === 'go') break;
    if (decision === 'cancel') return 0;
  }

  console.log(`\nRun ${runId}${existing ? tr(' (ajout)', ' (addition)') : ''}\n`);
  await runBenchLive({ runId, runsRoot: root, plan: choice.plan, herdr: new Herdr(), agentPaths: paths, catalogRoots: [userCatalogPath()], append: !!existing });
  console.log(`\n${DISCLAIMER}\n${pricesLine()}`);
  await presentRun(`${root}/${runId}`);
  return 0;
}

interface BenchChoice {
  plan: BenchPlan;
}

/** Ids `<task>__<model>__<mode>` of the jobs a run already holds. */
async function doneJobs(runDir: string): Promise<Set<string>> {
  const { readdir, access } = await import('node:fs/promises');
  const out = new Set<string>();
  for (const d of await readdir(runDir).catch(() => [] as string[])) {
    if (await access(`${runDir}/${d}/job.json`).then(() => true, () => false)) out.add(d);
  }
  return out;
}

/** Returned by a step when the user picks « ← Retour ». */
const BACK = '__back__';
const backChoice = () => ({ name: tr('← Retour', '← Back'), value: BACK });
const backBox = () => ({ name: tr('← Retour à la question précédente', '← Back to the previous question'), value: BACK });

/** Checkbox with a « back » entry: returns BACK when it is ticked, whatever else is. */
async function checkboxOrBack(o: Parameters<typeof checkbox>[0]): Promise<string[] | typeof BACK> {
  const picked = (await checkbox({
    ...o,
    choices: [...(o.choices as any[]), new Separator(' '), backBox()],
    validate: (items: readonly any[]) => (items.length ? true : tr('Coche au moins une option, ou « ← Retour ».', 'Tick at least one option, or « ← Back ».')),
  })) as string[];
  return picked.includes(BACK) ? BACK : picked;
}

/**
 * The questions shared by a new bench and an addition to an existing one, as steps: every step can
 * go back to the previous one, and earlier answers are kept as defaults. Returns BACK from the
 * first step (back to the start menu).
 */
async function chooseBench(agents: AgentInfo[], existing: RunSummary | null): Promise<BenchChoice | typeof BACK | null> {
  const st: {
    models?: string[]; what?: string; taskIds?: string[]; modes?: Mode[]; tester?: string; execution?: string;
  } = {};
  const roots = [catalogPath(), userCatalogPath()];
  const tasks = await listTasks(roots);
  const catalog = tasks.filter((t) => !t.id.startsWith('idee-'));
  const preselected = existing ? new Set(existing.models) : PRESELECTED;

  const steps: Array<() => Promise<boolean>> = [
    // 1. Models — for an addition, the run's models are pre-checked (to add a project to them).
    async () => {
      const chosen = new Set(st.models ?? [...preselected]);
      const modelChoices: Array<{ name: string; value: string; checked?: boolean; disabled?: string } | Separator> = [];
      for (const a of agents) {
        if (a.installed && a.supported && a.models.length) {
          modelChoices.push(new Separator(`— ${a.label} ${a.version}`));
          for (const m of a.models) modelChoices.push({ name: `${label(m)}  (${m.replace(/^cursor:/, '')})`, value: m, checked: chosen.has(m) });
        }
      }
      const missing = agents.filter((a) => !a.installed || !a.supported);
      if (missing.length) {
        modelChoices.push(new Separator(tr('— Non disponibles', '— Not available')));
        for (const a of missing) modelChoices.push({ name: a.label, value: `x-${a.id}`, disabled: a.installed ? tr('pas encore pris en charge', 'not supported yet') : `${tr('non installé', 'not installed')} → ${a.installHint}` });
      }
      const r = await checkboxOrBack({ message: tr('Modèles (espace = cocher)', 'Models (space = tick)'), choices: modelChoices, pageSize: 20 });
      if (r === BACK) return false;
      st.models = r;
      return true;
    },
    // 2. Projects
    async () => {
      const r = await select({
        message: tr('Projets', 'Projects'),
        default: st.what,
        choices: [
          { name: tr(`Run all (${catalog.length} projets du catalogue)`, `Run all (${catalog.length} catalog projects)`), value: 'all' },
          { name: tr('Choisir des projets', 'Pick projects'), value: 'pick' },
          { name: tr('Bench my idea instead (ton idée devient une tâche)', 'Bench my idea instead (your idea becomes a task)'), value: 'idea' },
          backChoice(),
        ],
      });
      if (r === BACK) return false;
      st.what = r;
      if (r === 'all') {
        st.taskIds = catalog.map((t) => t.id);
        return true;
      }
      if (r === 'pick') {
        const picked = await checkboxOrBack({
          message: tr('Projets à générer', 'Projects to build'),
          choices: tasks.map((t) => ({
            name: `${t.id.padEnd(8)} ${t.title}  · ${t.category} · ~${t.budgetMinutes} min${existing?.tasks.includes(t.id) ? tr('  (déjà dans ce bench)', '  (already in this bench)') : ''}`,
            value: t.id,
            checked: st.taskIds?.includes(t.id) ?? false,
          })),
          pageSize: 20,
        });
        if (picked === BACK) return steps[1]!();
        st.taskIds = picked;
        return true;
      }
      const title = await input({ message: tr('Nom du projet (ex. « Jeu 3D de course ») — vide pour revenir', 'Project name (e.g. « 3D racing game ») — empty to go back') });
      if (!title.trim()) return steps[1]!();
      const idea = await input({ message: tr('Décris ton idée en quelques phrases (ce que la page doit faire et montrer)', 'Describe your idea in a few sentences (what the page must do and show)'), required: true });
      const task = await createIdeaTask(title, idea);
      console.log(`\n${tr('Prompt qui sera envoyé à chaque agent :', 'Prompt that will be sent to every agent:')}\n\n${task.prompt}\n`);
      if (!(await confirm({ message: tr('Ce prompt te convient ?', 'Is this prompt fine?'), default: true }))) {
        console.log(tr(`Tu peux l'éditer ici : ${task.dir}/prompt.md`, `You can edit it here: ${task.dir}/prompt.md`));
        return steps[1]!();
      }
      st.taskIds = [task.id];
      return true;
    },
    // 3. Modes
    async () => {
      const chosen = new Set(st.modes ?? ['bare']);
      const r = await checkboxOrBack({
        message: 'Modes',
        choices: [
          { name: tr('sans harness — l\'agent brut : aucune instruction perso, skill, plugin, MCP ni hook', 'without harness — the bare agent: no personal instructions, skills, plugins, MCP or hooks'), value: 'bare', checked: chosen.has('bare') },
          { name: tr('avec harness — ta config locale : instructions, skills, plugins, MCP, hooks', 'with harness — your local setup: instructions, skills, plugins, MCP, hooks'), value: 'harness', checked: chosen.has('harness') },
        ],
      });
      if (r === BACK) return false;
      st.modes = r as Mode[];
      if (st.modes.includes('harness')) console.log(tr('  ⚠️ Avec harness, ta config est active pendant le run (MCP, hooks…), dans un dossier jetable.', '  ⚠️ With harness, your setup is active during the run (MCP, hooks…), in a disposable folder.'));
      return true;
    },
    // 4. Tester
    async () => {
      const r = await select({
        message: tr('Recette', 'Testing'),
        default: st.tester,
        choices: [
          { name: tr('Testeur indépendant (modèle de l\'autre fournisseur) + checks automatiques', 'Independent tester (a model from the other provider) + automatic checks'), value: 'auto' },
          { name: tr('Checks automatiques seulement (moins cher, moins complet : pas de fix au-delà des checks)', 'Automatic checks only (cheaper, less thorough: no fixes beyond the checks)'), value: 'none' },
          backChoice(),
        ],
      });
      if (r === BACK) return false;
      st.tester = r;
      return true;
    },
    // 5. Execution
    async () => {
      const r = await select({
        message: tr('Exécution', 'Execution'),
        default: st.execution,
        choices: [
          { name: tr('En vagues : un projet à la fois, tous les modèles en parallèle', 'In waves: one project at a time, all models in parallel'), value: 'waves' },
          { name: tr('Séquentiel : un job à la fois (chrono sans concurrence, plus long)', 'Sequential: one job at a time (timing without contention, longer)'), value: 'sequential' },
          backChoice(),
        ],
      });
      if (r === BACK) return false;
      st.execution = r;
      return true;
    },
  ];

  for (let i = 0; i < steps.length; ) {
    if (await steps[i]!()) i++;
    else if (i === 0) return BACK;
    else i--;
  }
  return {
    plan: { tasks: st.taskIds!, models: st.models!, modes: st.modes!, effort: 'medium', tester: st.tester!, maxFixRounds: 3, sequential: st.execution === 'sequential' },
  };
}


/** Lists recent runs and returns the chosen run id, or null when there is none. */
async function pickRun(message: string): Promise<string | null> {
  const runs = await listRecentRuns(runsRoot());
  if (!runs.length) {
    console.log(tr('Aucun bench pour l\'instant : lance d\'abord un nouveau bench.', 'No bench yet: start a new one first.'));
    return null;
  }
  const when = (id: string) => `${id.slice(6, 8)}/${id.slice(4, 6)} ${id.slice(9, 11)}:${id.slice(11, 13)}`;
  const picked = await select({
    message,
    pageSize: 15,
    choices: [backChoice(), ...runs.map((r) => ({
      name: `${when(r.runId)}  ${r.tasks.join(', ')}  ·  ${r.models.map((m) => modelColor(m)(label(m))).join(', ')}  ·  ${r.works}/${r.jobs} ${tr('qui marchent', 'working')}`,
      value: r.runId,
    }))],
  });
  return picked === BACK ? null : picked;
}

async function recap(plan: BenchPlan, root: string, paths: ReturnType<typeof defaultAgentPaths>, already = new Set<string>()): Promise<'go' | 'edit' | 'cancel'> {
  const waves = planWaves(plan)
    .map((w) => ({ ...w, jobs: w.jobs.filter((j) => !already.has(`${w.task}__${j.model.replace(/:/g, '-')}__${j.mode}`)) }))
    .filter((w) => w.jobs.length);
  if (!waves.length) {
    console.log(tr('\nToutes ces combinaisons sont déjà dans ce bench : rien à ajouter.', '\nAll these combinations are already in this bench: nothing to add.'));
    return 'edit';
  }
  const tasks = await listTasks([catalogPath(), userCatalogPath()]);
  const budget = (id: string) => tasks.find((t) => t.id === id)?.budgetMinutes ?? 15;
  const jobs: PlannedJob[] = waves.flatMap((w) =>
    w.jobs.map((j) => {
      const agent = adapterFor(j.model).kind;
      return { task: w.task, model: j.model, agent, testerAgent: plan.tester === 'none' ? null : adapterFor(DEFAULT_TESTER[agent]!).kind };
    }),
  );
  // A wave lasts as long as its slowest job; build + QA + fixes ≈ 2 × the task budget.
  const minutes = waves.reduce((s, w) => s + budget(w.task) * 2, 0);
  const history = await quotaHistory(root);
  const costs = jobs.map((j) => history.costByTaskModel[`${j.task}|${j.model}`]?.avg);
  const knownCost = costs.filter((c): c is number => c !== undefined);

  console.log(tr('\n── Récapitulatif ─────────────────────────────', '\n── Summary ───────────────────────────────────'));
  console.log(tr(`${jobs.length} job(s) à lancer · ${waves.length} vague(s)${already.size ? ` · ${already.size} job(s) déjà dans ce bench, ignorés` : ''}`, `${jobs.length} job(s) to run · ${waves.length} wave(s)${already.size ? ` · ${already.size} job(s) already in this bench, skipped` : ''}`));
  console.log(tr(`Durée estimée : ~${minutes} min`, `Estimated duration: ~${minutes} min`));
  console.log(
    knownCost.length
      ? `${tr('Coût éq. API estimé : ~', 'Estimated API-equivalent cost: ~')}${dec(knownCost.reduce((a, b) => a + b, 0).toFixed(2))} $${knownCost.length < jobs.length ? tr(` (+ ${jobs.length - knownCost.length} job(s) sans historique)`, ` (+ ${jobs.length - knownCost.length} job(s) without history)`) : ''}`
      : tr('Coût éq. API estimé : inconnu (aucun run précédent de ces combinaisons)', 'Estimated API-equivalent cost: unknown (no previous run of these combinations)'),
  );

  const need = estimateNeed(history, jobs);
  console.log(tr('\nQuota (fenêtre 5 h) — lecture en cours…', '\nQuota (5 h window) — reading…'));
  let blocking = false;
  for (const [agent, n] of Object.entries(need)) {
    const reading = await probeQuota(adapterFor(agent === 'claude' ? 'claude-haiku-4-5' : 'gpt-6-luna'), new Herdr(), paths, root);
    const remaining = reading?.window5hPct !== null && reading?.window5hPct !== undefined ? 100 - reading.window5hPct : null;
    const v = quotaVerdict(n, remaining);
    const plan = reading?.plan ? ` (${reading.plan})` : '';
    const left = remaining === null ? tr('reste inconnu', 'remaining unknown') : tr(`reste ${remaining} %`, `${remaining} % left`);
    const est = n.known ? tr(`besoin estimé ~${n.pct} %${n.unknown ? ` + ${n.unknown} job(s) sans historique` : ''}`, `estimated need ~${n.pct} %${n.unknown ? ` + ${n.unknown} job(s) without history` : ''}`) : tr('besoin inconnu (pas d\'historique)', 'need unknown (no history)');
    const icon = { ok: tr('✅ tient', '✅ fits'), tight: tr('⚠️ juste : risque de pause quota', '⚠️ tight: may pause on quota'), ko: tr('❌ ne tient pas', '❌ does not fit'), unknown: tr('❔ estimation impossible', '❔ cannot estimate') }[v];
    console.log(`  ${agent}${plan}${tr(' :', ':')} ${left} · ${est} → ${icon}`);
    if (v === 'ko') blocking = true;
  }
  if (blocking) {
    console.log(tr('  Pour réduire le besoin : décoche des modèles, des projets ou le mode « avec harness », ou choisis', '  To reduce the need: untick models, projects or the « with harness » mode, or choose'));
    console.log(tr('  « checks automatiques seulement » (le testeur consomme le quota de l\'autre fournisseur).', '  « automatic checks only » (the tester uses the other provider\'s quota).'));
    console.log(tr('  Sinon, un job en pause quota reprend après la remise à zéro de la fenêtre.', '  Otherwise, a job paused on quota resumes once the window resets.'));
  }
  console.log('──────────────────────────────────────────────');
  return select({
    message: tr('Lancer le bench ?', 'Start the bench?'),
    default: blocking ? 'edit' : 'go',
    choices: [
      { name: tr('Lancer', 'Start'), value: 'go' },
      { name: tr('← Modifier mes choix', '← Change my choices'), value: 'edit' },
      { name: tr('Annuler', 'Cancel'), value: 'cancel' },
    ],
  }) as Promise<'go' | 'edit' | 'cancel'>;
}
