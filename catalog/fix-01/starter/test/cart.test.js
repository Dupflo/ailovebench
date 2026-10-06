import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, withVat, total, formatPrice } from '../src/cart.js';

const items = [
  { name: 'Carnet', unitPrice: 450, quantity: 2 },
  { name: 'Stylo', unitPrice: 120, quantity: 3 },
];

test('subtotal tient compte des quantités', () => {
  assert.equal(subtotal(items), 1260);
});

test('BIENVENUE10 retire 10 %', () => {
  assert.equal(applyDiscount(2000, 'BIENVENUE10'), 1800);
});

test('MOINS5 retire 5 €', () => {
  assert.equal(applyDiscount(2000, 'MOINS5'), 1500);
});

test('withVat ajoute 20 %', () => {
  assert.equal(withVat(1000), 1200);
});

test('total enchaîne sous-total, remise et TVA', () => {
  assert.equal(total(items, 'MOINS5'), 912);
});

test('formatPrice suit le format français', () => {
  assert.equal(formatPrice(1250), new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(12.5));
});
