const CODES = { BIENVENUE10: { type: 'percent', value: 10 }, MOINS5: { type: 'fixed', value: 500 } };
const roundHalfUp = (x) => Math.floor(x + 0.5);
export function subtotal(items) { return items.reduce((s, i) => s + i.unitPrice * i.quantity, 0); }
export function applyDiscount(cents, code) {
  if (code === undefined || code === null) return cents;
  const d = CODES[String(code).toUpperCase()];
  if (!d) throw new Error('Code promo inconnu');
  const r = d.type === 'percent' ? roundHalfUp((cents * (100 - d.value)) / 100) : cents - d.value;
  return Math.max(0, r);
}
export function withVat(cents, rate = 0.2) { return roundHalfUp(cents * (1 + rate)); }
export function total(items, code) { return withVat(applyDiscount(subtotal(items), code)); }
const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
export function formatPrice(cents) { return fmt.format(cents / 100); }
