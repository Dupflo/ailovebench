import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { catalogPath } from '../paths.js';
import { tr } from '../i18n.js';
import type { Deliverable } from '../checks/types.js';
import type { CheckSpec } from '../checks/run.js';

export interface Task {
  id: string;
  title: string;
  category: string;
  /** Hard limit for one build or fix turn. */
  timeoutMin: number;
  /** Full prompt sent to the agent (task + deliverable contract + autonomy rules). */
  prompt: string;
  dir: string;
  /** How the product is built and served; null for tasks without a site (e.g. a bug-fix task). */
  deliverable: Deliverable | null;
  checks: CheckSpec[];
  /** Copied into the work folder before the agent starts. */
  starter: string | null;
  /** Rough duration of one job, used before any real run exists for the estimate. */
  budgetMinutes: number;
  /** Repair tasks: the starter (buggy version) is also built and captured, for a before / after. */
  beforeAfter: boolean;
  /** Repair tasks: the bugs planted in the starter, explained, each tied to the checks that prove it. */
  knownBugs: KnownBug[];
}

export interface KnownBug {
  id: string;
  title: string;
  /** Where the bug lives (file, function). */
  where?: string;
  /** What a user sees. */
  symptom?: string;
  /** Check ids (`scenario.remove_one`), or `<check>:<test name>` for one failing test of a test check. */
  evidence: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  category: string;
  budgetMinutes: number;
}

/** Tasks of the built-in catalog and of the user's own catalog (`~/.ailovebench/catalog`). */
export async function listTasks(roots: string[] = [catalogPath()]): Promise<TaskSummary[]> {
  const out: TaskSummary[] = [];
  for (const root of roots) {
    let ids: string[] = [];
    try {
      ids = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        const t = await loadTask(id, root);
        out.push({ id: t.id, title: t.title, category: t.category, budgetMinutes: t.budgetMinutes });
      } catch {
        // Not a task folder.
      }
    }
  }
  return out;
}

/** Finds a task in the built-in catalog first, then in the given extra roots. */
export async function findTask(id: string, extraRoots: string[] = []): Promise<Task> {
  for (const root of [catalogPath(), ...extraRoots]) {
    try {
      return await loadTask(id, root);
    } catch {
      // Try the next catalog.
    }
  }
  throw new Error(tr(`Tâche inconnue : ${id}`, `Unknown task: ${id}`));
}

/** Appended to every task prompt so all agents get the same working rules. */
export const AUTONOMY_RULES = `

---
Règles de travail (identiques pour tous les agents testés) :
- Travaille en autonomie complète dans le dossier courant. Ne pose aucune question : si un point est ambigu, fais un choix raisonnable et note-le dans le README.
- Installe ce dont tu as besoin. N'utilise aucun service en ligne payant ni clé d'API.
- Quand le travail est fini et vérifié, termine par une seule ligne : « TERMINÉ ».`;

export async function loadTask(id: string, root = catalogPath()): Promise<Task> {
  const dir = path.join(root, id);
  const manifest = path.join(dir, 'task.yaml');
  try {
    await access(manifest);
  } catch {
    throw new Error(tr(`Tâche inconnue : ${id} (pas de ${manifest})`, `Unknown task: ${id} (no ${manifest})`));
  }
  const meta = parse(await readFile(manifest, 'utf8'));
  const prompt = await readFile(path.join(dir, meta.prompt ?? 'prompt.md'), 'utf8');
  return {
    id: meta.id ?? id,
    title: meta.title,
    category: meta.category,
    timeoutMin: Number(meta.timeout_min ?? 30),
    prompt: prompt.trim() + AUTONOMY_RULES,
    dir,
    deliverable: meta.deliverable ?? null,
    checks: meta.checks ?? [],
    starter: meta.starter ? path.join(dir, meta.starter) : null,
    budgetMinutes: Number(meta.budget?.minutes ?? 15),
    beforeAfter: Boolean(meta.before_after) && Boolean(meta.starter) && Boolean(meta.deliverable),
    knownBugs: (meta.known_bugs ?? []).map((b: any) => ({ ...b, evidence: b.evidence ?? [] })),
  };
}
