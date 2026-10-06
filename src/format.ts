import { loadPrices, priceTableAge } from './measure/prices.js';
import { visibleLength } from './ui/colors.js';
import type { Cost, TokenUsage } from './measure/types.js';
import { dec, tr } from './i18n.js';

/** The cost disclaimer, in the current language. */
export const disclaimer = (): string =>
  tr(
    'Coût équivalent API estimé à partir des tokens et d\'une table de prix datée. Ce n\'est pas une facture.',
    'API-equivalent cost estimated from tokens and a dated price table. This is not an invoice.',
  );

/** Same text, kept for `${DISCLAIMER}` call sites: resolved when it is printed, not at import. */
export const DISCLAIMER = { toString: disclaimer };

/** « Prix relevés le 2026-10-01 (il y a 3 j) », with a warning once the table is too old. */
export function pricesLine(now = new Date()): string {
  const prices = loadPrices();
  const age = priceTableAge(prices, now);
  const base = tr(`Prix relevés le ${age.updatedAt} (il y a ${age.days} j)`, `Prices checked on ${age.updatedAt} (${age.days} d ago)`);
  return age.stale
    ? tr(
        `${base} ⚠️ table de plus de ${prices.max_age_days} j : à mettre à jour (data/prices.json).`,
        `${base} ⚠️ table older than ${prices.max_age_days} d: update data/prices.json.`,
      )
    : base;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${dec((n / 1_000_000).toFixed(2))} M`;
  if (n >= 1_000) return `${dec((n / 1_000).toFixed(1))} k`;
  return String(n);
}

export function fmtCost(c: Cost): string {
  if (c.value === null) return tr('non chiffré', 'not priced');
  const v = `${dec(c.value.toFixed(2))} $`;
  return c.kind === 'partial' ? `${v} ${tr('(partiel)', '(partial)')}` : `≈ ${v}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
}

export function fmtUsage(u: TokenUsage): string {
  return [
    `${tr('entrée', 'input')} ${fmtTokens(u.input)}`,
    `${tr('sortie', 'output')} ${fmtTokens(u.output)}`,
    `${tr('écr. cache 5 min', 'cache write 5 min')} ${fmtTokens(u.cacheWrite5m)}`,
    `${tr('écr. cache 1 h', 'cache write 1 h')} ${fmtTokens(u.cacheWrite1h)}`,
    `${tr('lecture cache', 'cache read')} ${fmtTokens(u.cacheRead)}`,
  ].join(' · ');
}

/** Minimal aligned text table; cells may contain ANSI colors (widths use the visible length). */
export function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const pad = (c: string, w: number) => c + ' '.repeat(Math.max(0, w - visibleLength(c)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c ?? '', widths[i]!)).join('  ').trimEnd();
  return [line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
