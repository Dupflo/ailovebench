import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { ACTIVE_GAP_MS, type ProjectReport, type Tool } from './measure/project.js';
import type { Bucket } from './measure/aggregate.js';
import type { Cost } from './measure/types.js';
import { disclaimer, fmtCost, fmtDuration, fmtTokens, table } from './format.js';
import { modelLabel } from './ui/model-label.js';
import { locale, tr } from './i18n.js';

/** Terminal and Markdown views of `ailovebench project`. Numbers and model names only. */

const TOOL_LABEL: Record<Tool, string> = { claude: 'Claude', codex: 'Codex' };

/** A model with no price is « non tarifé », never 0 $. */
const cost = (c: Cost): string => (c.value === null ? tr('non tarifé', 'not priced') : fmtCost(c));

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const writeTotal = (b: Bucket) => b.usage.cacheWrite5m + b.usage.cacheWrite1h;

function pricesText(r: ProjectReport): string {
  const p = r.prices;
  const base = tr(`Prix relevés le ${p.updatedAt} (il y a ${p.days} j)`, `Prices checked on ${p.updatedAt} (${p.days} d ago)`);
  return p.stale
    ? tr(
        `${base} ⚠️ table de plus de ${p.maxAgeDays} j : les prix ont peut-être changé.`,
        `${base} ⚠️ table older than ${p.maxAgeDays} d: prices may have changed.`,
      )
    : base;
}

const unpricedText = (r: ProjectReport): string | null =>
  r.summary.unpricedModels.length
    ? tr(
        `Non tarifé (absent de la table de prix, non compté dans le coût) : ${r.summary.unpricedModels.join(', ')}`,
        `Not priced (missing from the price table, left out of the cost): ${r.summary.unpricedModels.join(', ')}`,
      )
    : null;

export function projectText(r: ProjectReport): string {
  const out: string[] = [];
  const t = r.summary.total;
  out.push(`${tr('Projet  ', 'Project ')} ${r.dir}`);
  if (!t.requests) {
    out.push(tr(
      '\nAucune session Claude Code ou Codex trouvée pour ce dossier (ni ses sous-dossiers) sur cette période.',
      '\nNo Claude Code or Codex session found for this folder (or its subfolders) in this period.',
    ));
    return out.join('\n');
  }
  out.push(`${tr('Période ', 'Period  ')} ${when(r.start)} → ${when(r.end)} · ${tr('durée active', 'active time')} ${fmtDuration(r.activeMs)}`);
  out.push(
    `Sessions ${r.sessions.total} (${r.byTool.map((b) => `${TOOL_LABEL[b.tool]} ${r.sessions[b.tool]}`).join(' · ')}) · ${t.requests} ${tr('requêtes', 'requests')}`,
  );
  out.push(
    `Tokens   ${[
      `${tr('entrée', 'input')} ${fmtTokens(t.usage.input)}`,
      `${tr('sortie', 'output')} ${fmtTokens(t.usage.output)}`,
      `${tr('écriture cache', 'cache write')} ${fmtTokens(writeTotal(t))}`,
      `${tr('lecture cache', 'cache read')} ${fmtTokens(t.usage.cacheRead)}`,
      `${tr('dont raisonnement', 'of which reasoning')} ${fmtTokens(t.usage.reasoning)}`,
    ].join(' · ')}`,
  );
  out.push(`${tr('Coût    ', 'Cost    ')} ${cost(t.cost)}\n`);

  const head = [
    tr('Requêtes', 'Requests'), tr('Entrée', 'Input'), tr('Sortie', 'Output'), tr('Écr. cache', 'Cache write'),
    tr('Lect. cache', 'Cache read'), tr('Raisonnement', 'Reasoning'), tr('Coût', 'Cost'),
  ];
  const cells = (b: Bucket) => [
    String(b.requests), fmtTokens(b.usage.input), fmtTokens(b.usage.output), fmtTokens(writeTotal(b)),
    fmtTokens(b.usage.cacheRead), fmtTokens(b.usage.reasoning), cost(b.cost),
  ];
  out.push(table([tr('Outil', 'Tool'), 'Sessions', ...head], r.byTool.map((b) => [TOOL_LABEL[b.tool], String(r.sessions[b.tool]), ...cells(b)])));
  out.push('');
  out.push(table([tr('Modèle', 'Model'), tr('Outil', 'Tool'), ...head], r.byModel.map((b) => [b.model, b.tools.map((x) => TOOL_LABEL[x]).join(' + '), ...cells(b)])));
  const unpriced = unpricedText(r);
  if (unpriced) out.push(`\n${unpriced}`);
  out.push(`\n${disclaimer()}\n${pricesText(r)}`);
  return out.join('\n');
}

/** The report written by `--write`: meant to be read on screen by a beginner (and in a video). */
export function projectMarkdown(r: ProjectReport, now = new Date()): string {
  const t = r.summary.total;
  const tools = r.byTool;
  const name = path.basename(r.dir);
  const md: string[] = [];
  md.push(`# ${tr(`Coût du projet « ${name} » en tokens`, `Token cost of the “${name}” project`)}`, '');
  md.push(`> ${disclaimer()}`, '');
  md.push(`- **${tr('Dossier', 'Folder')}** : \`${name}\` ${tr('(et ses sous-dossiers)', '(and its subfolders)')}`);
  md.push(`- **${tr('Période', 'Period')}** : ${tr(`du ${when(r.start)} au ${when(r.end)}`, `from ${when(r.start)} to ${when(r.end)}`)}`);
  md.push(`- **${tr('Durée active', 'Active time')}** : ${fmtDuration(r.activeMs)} ${tr(`(les pauses de plus de ${ACTIVE_GAP_MS / 60_000} min ne comptent pas)`, `(breaks longer than ${ACTIVE_GAP_MS / 60_000} min are left out)`)}`);
  md.push(`- **${tr('Rapport généré le', 'Report generated on')}** : ${when(now.toISOString())}`);
  md.push(`- **${tr('Table de prix', 'Price table')}** : ${pricesText(r)}`);
  md.push('');

  if (!t.requests) {
    md.push(tr(
      'Aucune session Claude Code ou Codex trouvée pour ce dossier sur cette période.',
      'No Claude Code or Codex session found for this folder in this period.',
    ), '');
    return md.join('\n');
  }

  md.push(`## ${tr('En résumé', 'Summary')}`, '');
  md.push(`**${tr('Coût équivalent API total', 'Total API-equivalent cost')} : ${cost(t.cost)}**`, '');
  const cols = [...tools.map((b) => TOOL_LABEL[b.tool]), 'Total'];
  const all = [...tools, t];
  md.push(`| | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---:').join('|')}|`);
  const row = (label: string, f: (b: Bucket, i: number) => string) => md.push(`| ${label} | ${all.map(f).join(' | ')} |`);
  row('Sessions', (_b, i) => String(i < tools.length ? r.sessions[tools[i]!.tool] : r.sessions.total));
  row(tr('Requêtes au modèle', 'Model requests'), (b) => String(b.requests));
  row(tr("Tokens d'entrée", 'Input tokens'), (b) => fmtTokens(b.usage.input));
  row(tr('Tokens de sortie', 'Output tokens'), (b) => fmtTokens(b.usage.output));
  row(tr('dont raisonnement', 'of which reasoning'), (b) => fmtTokens(b.usage.reasoning));
  row(tr('Écriture en cache', 'Cache write'), (b) => fmtTokens(writeTotal(b)));
  row(tr('Lecture du cache', 'Cache read'), (b) => fmtTokens(b.usage.cacheRead));
  row(`**${tr('Coût équivalent API', 'API-equivalent cost')}**`, (b) => `**${cost(b.cost)}**`);
  md.push('');

  if (t.cost.value !== null && tools.length > 1) {
    const share = tools
      .map((b) => `${TOOL_LABEL[b.tool]} ${b.cost.value === null || !t.cost.value ? '—' : `${Math.round((b.cost.value / t.cost.value) * 100)} %`}`)
      .join(' · ');
    md.push(`${tr('Part du coût', 'Share of the cost')} : ${share}`, '');
  }

  md.push(`## ${tr('Par modèle', 'By model')}`, '');
  md.push(
    `| ${tr('Modèle', 'Model')} | ${tr('Outil', 'Tool')} | ${tr('Requêtes', 'Requests')} | ${tr('Entrée', 'Input')} | ${tr('Sortie', 'Output')} | ${tr('Écriture cache', 'Cache write')} | ${tr('Lecture cache', 'Cache read')} | ${tr('Coût', 'Cost')} |`,
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const b of r.byModel) {
    md.push(
      `| ${modelLabel(b.model)} | ${b.tools.map((x) => TOOL_LABEL[x]).join(' + ')} | ${b.requests} | ${fmtTokens(b.usage.input)} | ${fmtTokens(b.usage.output)} | ${fmtTokens(writeTotal(b))} | ${fmtTokens(b.usage.cacheRead)} | ${cost(b.cost)} |`,
    );
  }
  md.push('');
  const unpriced = unpricedText(r);
  if (unpriced) md.push(`${unpriced}.`, '');

  md.push(`## ${tr('Comment lire ces chiffres', 'How to read these numbers')}`, '');
  md.push(
    tr(
      `- Un **token** est un petit morceau de texte (environ ¾ de mot). Le modèle est facturé au token, en **entrée** (ce qu'il lit) et en **sortie** (ce qu'il écrit, raisonnement compris).
- Le **cache** évite de refaire payer plein tarif un contexte déjà envoyé : l'**écriture** en cache coûte un peu plus que l'entrée, la **lecture** coûte environ 10 fois moins. C'est pourquoi la lecture du cache pèse des millions de tokens mais peu de dollars.
- Le **coût équivalent API** est ce que ces tokens auraient coûté via l'API, au tarif public. Avec un abonnement (Claude Pro/Max, ChatGPT Plus/Pro), vous ne payez pas ce montant : il sert à comparer et à mesurer l'effort.
- Sont comptées toutes les sessions Claude Code (application de bureau, terminal, sous-agents) et Codex (application ChatGPT, terminal, \`codex exec\`) lancées dans ce dossier ou un sous-dossier.`,
      `- A **token** is a small piece of text (about ¾ of a word). Models are billed per token, for **input** (what they read) and **output** (what they write, reasoning included).
- The **cache** avoids paying full price again for context already sent: a cache **write** costs a bit more than input, a cache **read** about 10 times less. That is why cache reads weigh millions of tokens but few dollars.
- The **API-equivalent cost** is what these tokens would have cost through the API at public prices. With a subscription (Claude Pro/Max, ChatGPT Plus/Pro) you do not pay this amount: it is for comparing and measuring effort.
- Every Claude Code session (desktop app, terminal, subagents) and Codex session (ChatGPT app, terminal, \`codex exec\`) started in this folder or a subfolder is counted.`,
    ),
    '',
  );
  md.push(`*${tr('Généré par', 'Generated by')} \`npx ailovebench project\`.*`, '');
  return md.join('\n');
}

/** Writes the report, replacing any previous one in a single step; creates the folder if needed. */
export async function writeProjectMarkdown(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}
