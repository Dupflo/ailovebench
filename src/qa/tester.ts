import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, Effort } from '../agents/types.js';
import type { Herdr } from '../herdr/client.js';
import type { AgentPaths } from '../paths.js';
import type { Task } from '../catalog/load.js';
import type { Summary } from '../measure/aggregate.js';
import { AgentSession, type PhaseRecord } from '../runner/session.js';
import { serveStatic } from '../checks/serve.js';
import { withBrowser } from '../checks/browser.js';
import { confirmBug } from './repro.js';
import type { Bug } from './bugs.js';
import { tr } from '../i18n.js';

export interface TesterConfig {
  adapter: AgentAdapter;
  model: string;
  timeoutMin?: number;
}

export interface TesterResult {
  agent: string;
  model: string;
  strengths: string[];
  weaknesses: string[];
  /** Tester bugs, confirmed or not (only confirmed ones go to the fix rounds). */
  bugs: Bug[];
  phases: PhaseRecord[];
  measure: Summary | null;
  /** Problems with the tester itself (no report, invalid JSON…), shown in the report. */
  notes: string[];
}

interface ReportBug {
  id?: string;
  scope?: string;
  title?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  severity?: string;
}

const reproCli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'repro-cli.js');
const playwrightModule = createRequire(import.meta.url).resolve('playwright');

export function testerPrompt(task: Task, url: string): string {
  const spec = task.prompt.split('\n---\nRègles de travail')[0]!.trim();
  return `# Recette d'un produit web

Tu es testeur QA indépendant. Tu ne vois pas le code : tu testes le produit comme un utilisateur
exigeant, dans un navigateur, à cette adresse : ${url}

## Le cahier des charges donné au développeur

${spec.replace(/^#/gm, '###')}

## Ta mission

1. Explore le produit avec Playwright (écris et lance des scripts Node dans ce dossier) : chaque
   exigence du cahier des charges, en 1280 px et en 375 px de large, au clavier, avec des cas limites.
   Playwright s'importe ainsi : \`import { chromium } from '${playwrightModule}';\`
2. Pour chaque bug (écart avec le cahier des charges, ou défaut évident pour un utilisateur), écris un
   script \`bugs/B<n>.mjs\` qui vérifie le comportement ATTENDU et qui ÉCHOUE tant que le bug existe :
   \`\`\`js
   export default async ({ page, url, assert }) => {
     // page : page Playwright déjà ouverte sur l'URL, en 1280×900.
     // Mobile : await page.setViewportSize({ width: 375, height: 800 });
     // assert : node:assert/strict
   };
   \`\`\`
   Vérifie chaque script avec \`node ${reproCli} bugs/B1.mjs ${url}\` : il doit afficher « BUG PRÉSENT ».
   Un script qui passe ne prouve aucun bug : supprime-le.
   Seul un \`assert\` qui échoue prouve un bug : un script qui plante (élément introuvable, délai
   dépassé) ne compte pas. Le développeur va corriger : écris des scripts qui survivent à une
   correction légitime. Trouve les éléments par leur rôle et leur texte
   (\`page.getByRole('button', { name: /Essayer/i })\`, \`page.getByText(…)\`), pas par la balise
   HTML, une classe ou la structure : un lien \`<a>\` peut devenir un \`<button>\`. Si l'élément
   attendu n'existe plus, fais échouer un \`assert\` explicite plutôt que de laisser le script planter.
3. Écris \`report.json\` :
   \`\`\`json
   {
     "strengths": ["3 à 6 points forts concrets"],
     "weaknesses": ["3 à 6 points faibles concrets (qui ne sont pas des bugs)"],
     "bugs": [{ "id": "B1", "scope": "cahier | hors_cahier", "title": "…", "steps": ["…"], "expected": "…", "actual": "…", "severity": "bloquant | majeur | mineur" }]
   }
   \`\`\`
   Chaque bug du rapport a son script \`bugs/<id>.mjs\`. Ne signale que des bugs réels et reproductibles.
   \`scope\` : \`cahier\` si le produit ne fait pas ce que le cahier des charges demande explicitement ;
   \`hors_cahier\` pour un défaut que le cahier des charges ne couvrait pas (il sera signalé comme
   remarque, sans être reproché au développeur). En cas de doute, choisis \`hors_cahier\`.

Règles : ne modifie rien en dehors de ce dossier, ne pose aucune question. Quand c'est fini,
termine par une seule ligne : « TERMINÉ ».`;
}

/**
 * Black-box test of a built static product by an agent from another provider. The tester works in
 * an anonymous folder outside the job, sees only a localhost URL and the spec, and its bugs count
 * only if their script reproduces them twice.
 */
export async function runTester(o: {
  task: Task;
  staticDir: string;
  /** Job folder: the tester's files are copied to `<job>/qa/round-0/tester` afterwards. */
  jobRoot: string;
  /** Anonymous sandbox root for the tester, outside the job folder. */
  sandboxRoot: string;
  tester: TesterConfig;
  effort: Effort;
  herdr: Herdr;
  agentPaths: AgentPaths;
  log?: (msg: string) => void;
}): Promise<TesterResult> {
  const log = o.log ?? (() => {});
  const anon = `projet-${randomBytes(3).toString('hex')}`;
  const root = path.join(o.sandboxRoot, anon);
  const cwd = path.join(root, 'recette');
  await mkdir(path.join(cwd, 'bugs'), { recursive: true });

  const server = await serveStatic(o.staticDir);
  const result: TesterResult = {
    agent: o.tester.adapter.kind, model: o.tester.model, strengths: [], weaknesses: [], bugs: [], phases: [], measure: null, notes: [],
  };
  let session: AgentSession | null = null;
  try {
    session = await AgentSession.open({
      herdr: o.herdr, adapter: o.tester.adapter, agentPaths: o.agentPaths, root, cwd, mode: 'bare', model: o.tester.model, effort: o.effort,
      label: `bm recette ${anon}`, log: (m) => log(`${tr('testeur', 'tester')} · ${m}`),
    });
    await session.prompt('recette', testerPrompt(o.task, server.url), o.tester.timeoutMin ?? 20);
    result.phases = session.phases;

    let report: { strengths?: string[]; weaknesses?: string[]; bugs?: ReportBug[] } = {};
    try {
      report = JSON.parse(await readFile(path.join(cwd, 'report.json'), 'utf8'));
    } catch {
      result.notes.push(tr('report.json absent ou invalide', 'report.json missing or invalid'));
    }
    result.strengths = (report.strengths ?? []).map(String);
    result.weaknesses = (report.weaknesses ?? []).map(String);

    const scripts = new Set((await readdir(path.join(cwd, 'bugs')).catch(() => [])).filter((f) => f.endsWith('.mjs')));
    await withBrowser(async (browser) => {
      for (const b of report.bugs ?? []) {
        const id = String(b.id ?? '').trim();
        const file = `${id}.mjs`;
        const base: Bug = {
          id: `T-${id}`,
          source: 'tester',
          scope: b.scope === 'hors_cahier' ? 'outside' : 'spec',
          title: String(b.title ?? id),
          ...(Array.isArray(b.steps) ? { steps: b.steps.map(String) } : {}),
          ...(b.expected ? { expected: String(b.expected) } : {}),
          ...(b.actual ? { actual: String(b.actual) } : {}),
          ...(['bloquant', 'majeur', 'mineur'].includes(String(b.severity)) ? { severity: b.severity as Bug['severity'] } : {}),
          script: path.join('qa', 'round-0', 'tester', 'bugs', file),
          status: 'unconfirmed',
          foundInRound: 0,
        };
        if (!id || !scripts.has(file)) {
          result.bugs.push({ ...base, script: undefined } as Bug);
          continue;
        }
        const r = await confirmBug(browser, path.join(cwd, 'bugs', file), server.url);
        const confirmed = r.present === true;
        result.bugs.push({
          ...base,
          status: !confirmed ? 'unconfirmed' : base.scope === 'outside' ? 'remark' : 'confirmed',
          ...(confirmed && !base.actual ? { actual: r.error } : {}),
        });
      }
    });
    const confirmed = result.bugs.filter((b) => b.status === 'confirmed').length;
    log(tr(`testeur : ${result.bugs.length} bug(s) signalé(s), ${confirmed} confirmé(s) par script`, `tester: ${result.bugs.length} bug(s) reported, ${confirmed} confirmed by script`));
  } finally {
    await server.close();
    if (session) {
      result.measure = (await session.measure())?.summary ?? null;
      await session.close();
    }
    await cp(cwd, path.join(o.jobRoot, 'qa', 'round-0', 'tester'), { recursive: true }).catch(() => {});
  }
  return result;
}
