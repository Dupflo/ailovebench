import { loadPrices, normalizeModelId } from '../measure/prices.js';
import { cursorModelId, cursorPriceModel, isCursorModel } from '../agents/cursor.js';

const PRICES = loadPrices();

const prettify = (id: string) =>
  id
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

/**
 * Readable model name for people: the price table's label (« Claude Sonnet 5.5 »), and for Cursor
 * the model it runs with its variant (« Claude Opus 5.5 high · Cursor », « Composer 2.5 · Cursor »).
 */
export function modelLabel(model: string): string {
  if (isCursorModel(model)) {
    const id = cursorModelId(model);
    const base = cursorPriceModel(id);
    const known = PRICES.models[base]?.label;
    // What the id adds to its priced model (effort…), minus words already in it: grok-4.7-medium-fast
    // priced as grok-4.7-fast reads « Grok 4.7 Fast medium ».
    const baseWords = new Set(base.split('-'));
    const variant = id.split('-').filter((w) => !baseWords.has(w)).join(' ');
    return `${known ?? prettify(base)}${variant ? ` ${variant}` : ''} · Cursor`;
  }
  return PRICES.models[normalizeModelId(model)]?.label ?? model;
}
