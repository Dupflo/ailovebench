const CODES = {
  BIENVENUE10: { type: 'percent', value: 10 },
  MOINS5: { type: 'fixed', value: 500 },
};

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice, 0);
}

export function applyDiscount(cents, code) {
  if (code === undefined || code === null) return cents;
  const discount = CODES[code];
  if (!discount) throw new Error('Code promo inconnu');
  if (discount.type === 'percent') return cents - discount.value;
  return cents - discount.value;
}

export function withVat(cents, rate = 0.2) {
  return Math.round(cents * (1 + rate));
}

export function total(items, code) {
  return withVat(applyDiscount(subtotal(items), code));
}

export function formatPrice(cents) {
  return `${(cents / 100).toFixed(2)} €`;
}
