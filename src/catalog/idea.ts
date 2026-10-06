import { benchHome } from '../paths.js';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The user's own tasks live next to the runs, never in the published catalog. */
export const userCatalogPath = (home = os.homedir()): string =>
  path.join(benchHome(home), 'catalog');

const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'idee';

export function ideaPrompt(title: string, idea: string): string {
  return `# ${title}

${idea.trim()}

## Exigences

- Responsive : utilisable de 375 px à 1440 px de large, sans défilement horizontal.
- Accessible : contrastes suffisants, titres hiérarchisés, navigation au clavier.
- Aucune erreur dans la console du navigateur.
- Aucune ressource externe (polices, images, scripts, CDN) : tout est servi localement.

## Contrat de livraison

- Le projet doit se construire avec \`npm install && npm run build\`.
- Le build doit produire un site statique dans \`dist/\`, avec \`dist/index.html\` comme point d'entrée.
- La stack est libre, tant que ce contrat est respecté.
- Ajoute un \`README.md\` court : stack choisie, commandes, choix faits.`;
}

/**
 * Turns a free-text idea into a replayable task: same delivery contract and generic checks as the
 * built-in web tasks; the tester covers what is specific to the idea.
 */
export async function createIdeaTask(title: string, idea: string, root = userCatalogPath()): Promise<{ id: string; dir: string; prompt: string }> {
  const d = new Date();
  const id = `idee-${d.toISOString().slice(0, 10)}-${slug(title)}`;
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  const prompt = ideaPrompt(title, idea);
  await writeFile(path.join(dir, 'prompt.md'), prompt + '\n');
  await writeFile(
    path.join(dir, 'task.yaml'),
    [
      `id: ${id}`,
      `title: ${JSON.stringify(title)}`,
      'category: Idée perso',
      'timeout_min: 30',
      'prompt: prompt.md',
      'deliverable:',
      '  install: npm install',
      '  build: npm run build',
      '  static_dir: dist',
      '  entry: index.html',
      'budget:',
      '  minutes: 15',
      'checks:',
      '  - build',
      '  - console',
      '  - external_requests',
      '  - responsive: { widths: [375, 768, 1440] }',
      '  - lighthouse: { min: { accessibility: 90 } }',
      '',
    ].join('\n'),
  );
  return { id, dir, prompt };
}
