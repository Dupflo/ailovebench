import type { RunData } from './data.js';
import { modelLabel } from '../ui/model-label.js';
import { tr } from '../i18n.js';

/** The two sentences every report must show, in the current language. */
export const mandatorySentences = () => ({
  caveat: tr('une indication, pas un classement', 'an indication, not a ranking'),
  disclaimer: tr("Ce n'est pas une facture", 'This is not an invoice'),
});

export interface RuleCheck {
  id: string;
  label: string;
  ok: boolean;
}

/** Plain text of an HTML page (tags, scripts and styles removed, entities for « ' » decoded). */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;| | /g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Every correct way to write the run's date, in French (« 1 octobre 2026 », « 1er / 1ᵉʳ octobre
 * 2026 », « 01/10/2026 ») and English (« October 1, 2026 », « 1 October 2026 », « 10/01/2026 »), plus ISO.
 */
export function dateForms(iso: string): string[] {
  const d = new Date(iso);
  const long = frDate(iso);
  const day = d.getDate();
  const rest = long.replace(/^\d+\s*/, '');
  const dd = String(day).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  const forms = [long, `${dd}/${mm}/${y}`, `${y}-${mm}-${dd}`, enDate(iso), `${day} ${month} ${y}`, `${mm}/${dd}/${y}`];
  if (day === 1) forms.push(`1er ${rest}`, `1ᵉʳ ${rest}`);
  return forms;
}

export const frDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
export const enDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * docs/REPORT_RULES.md, as checks on the visible text of a report. `essentialOnly`: the subset an
 * AI-made layout must also show (conditions of the run and the mandatory sentences).
 */
export function checkReportRules(text: string, run: RunData, essentialOnly = false): RuleCheck[] {
  const has = (s: string | number | null | undefined) => s !== null && s !== undefined && String(s) !== '' && text.includes(String(s));
  const m = run.machine ?? {};
  const must = mandatorySentences();
  const checks: RuleCheck[] = [
    { id: 'caveat', label: tr(`Mention « ${must.caveat} »`, `Sentence "${must.caveat}"`), ok: has(must.caveat) },
    { id: 'disclaimer', label: tr(`Mention « ${must.disclaimer} »`, `Sentence "${must.disclaimer}"`), ok: has(must.disclaimer) },
    { id: 'date', label: tr('Date du run', 'Run date'), ok: !run.startedAt || dateForms(run.startedAt).some(has) },
    { id: 'os', label: tr('Système', 'Operating system'), ok: !m.os || has(m.os) },
    { id: 'cpu', label: tr('Processeur', 'Processor'), ok: !m.cpu || has(m.cpu) },
    { id: 'ram', label: tr('Mémoire vive', 'Memory'), ok: !m.ramGb || has(`${m.ramGb} ${tr('Go', 'GB')}`) },
    // « 755,7 s » / "755.7 s" is unreadable: past a minute, durations are written in minutes.
    { id: 'amounts', label: tr('Montants arrondis (pas de « 0,1191164 USD »)', 'Rounded amounts (no "0.1191164 USD")'), ok: !/\d[,.]\d{5,}/.test(text) },
    { id: 'durations', label: tr('Durées de plus de 60 s écrites en minutes', 'Durations over 60 s written in minutes'), ok: !/(?<![\d,.])(?:[6-9]\d|\d{3,})(?:[,.]\d+)?\s?s\b/.test(text) },
  ];
  if (essentialOnly) return checks;
  const versions = run.versions ?? {};
  checks.push(
    { id: 'cores', label: tr('Nombre de cœurs', 'Number of cores'), ok: !m.cores || has(`${m.cores} ${tr('cœurs', 'cores')}`) },
    { id: 'gpu', label: 'GPU', ok: !(m.gpus?.length) || m.gpus.every((g: any) => has(g.name)) },
    { id: 'node', label: tr('Version de Node', 'Node version'), ok: !m.node || has(m.node) },
    ...Object.entries(versions)
      .filter(([, v]) => v)
      .map(([k, v]) => ({ id: `version.${k}`, label: `Version ${k}`, ok: has(v) })),
    ...[...new Set(run.jobs.map((j) => j.model))].map((model) => ({ id: `model.${model}`, label: `${tr('Modèle', 'Model')} ${model}`, ok: has(modelLabel(model)) })),
    { id: 'prices', label: tr('Date de la table de prix', 'Price table date'), ok: !run.pricesUpdatedAt || has(run.pricesUpdatedAt) },
    { id: 'method', label: tr('Slide Méthode', 'Method slide'), ok: has(tr('Méthode', 'Method')) },
    { id: 'conditions', label: tr('Slide « Conditions du bench »', 'Slide "Bench conditions"'), ok: has(tr('Conditions du bench', 'Bench conditions')) },
  );
  return checks;
}

export const failedRules = (checks: RuleCheck[]) => checks.filter((c) => !c.ok);
