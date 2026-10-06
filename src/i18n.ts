/**
 * Language of everything people read (CLI, wizard, report): the computer's own, French when the
 * system locale is French, English otherwise. AILOVEBENCH_LANG=fr|en forces it.
 *
 * Each text carries both versions where it is used — `tr('Rapport', 'Report')` — so there is no
 * key file to keep in sync.
 */
export type Lang = 'fr' | 'en';

export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const forced = env.AILOVEBENCH_LANG?.toLowerCase();
  if (forced === 'fr' || forced === 'en') return forced;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '';
  return locale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

let current: Lang = detectLang();

export const lang = (): Lang => current;

/** For tests and for rebuilding a report in a given language. */
export function setLang(l: Lang): void {
  current = l;
}

/** The text in the current language. */
export const tr = (fr: string, en: string): string => (current === 'fr' ? fr : en);

/** Locale for dates and numbers (« 1 octobre 2026 » / « October 1, 2026 »). */
export const locale = (): string => (current === 'fr' ? 'fr-FR' : 'en-US');

/** Decimal separator of the current language: « 1,17 » in French, « 1.17 » in English. */
export const dec = (n: string): string => (current === 'fr' ? n.replace('.', ',') : n);
