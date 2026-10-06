// Hidden tests of fix-01: the whole README specification, not only the provided tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, withVat, total, formatPrice } from '../src/cart.js';

const fr = (euros) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(euros);

test('subtotal : panier vide', () => assert.equal(subtotal([]), 0));
test('subtotal : ligne de quantité 0 ignorée', () =>
  assert.equal(subtotal([{ name: 'a', unitPrice: 999, quantity: 0 }, { name: 'b', unitPrice: 100, quantity: 1 }]), 100));
test('subtotal : plusieurs lignes', () =>
  assert.equal(subtotal([{ name: 'a', unitPrice: 333, quantity: 3 }, { name: 'b', unitPrice: 1, quantity: 7 }]), 1006));

test('BIENVENUE10 : arrondi au centime, 0,5 vers le haut', () => assert.equal(applyDiscount(1005, 'BIENVENUE10'), 905));
test('BIENVENUE10 : arrondi vers le bas sous 0,5', () => assert.equal(applyDiscount(1001, 'BIENVENUE10'), 901));
test('codes insensibles à la casse', () => {
  assert.equal(applyDiscount(2000, 'bienvenue10'), 1800);
  assert.equal(applyDiscount(2000, 'Moins5'), 1500);
});
test('MOINS5 : jamais négatif', () => assert.equal(applyDiscount(300, 'MOINS5'), 0));
test('sans code : montant inchangé', () => {
  assert.equal(applyDiscount(1234, undefined), 1234);
  assert.equal(applyDiscount(1234, null), 1234);
});
test('code inconnu : erreur', () => assert.throws(() => applyDiscount(1000, 'GRATUIT'), /Code promo inconnu/));

test('withVat : arrondi 0,5 vers le haut', () => assert.equal(withVat(3), 4));
test('withVat : autre taux', () => assert.equal(withVat(1000, 0.055), 1055));

test('total avec BIENVENUE10', () =>
  assert.equal(total([{ name: 'a', unitPrice: 1005, quantity: 1 }], 'BIENVENUE10'), 1086));
test('total sans code', () => assert.equal(total([{ name: 'a', unitPrice: 1000, quantity: 2 }]), 2400));
test('total ne passe jamais sous 0', () => assert.equal(total([{ name: 'a', unitPrice: 100, quantity: 1 }], 'MOINS5'), 0));

test('formatPrice : milliers', () => assert.equal(formatPrice(123450), fr(1234.5)));
test('formatPrice : zéro', () => assert.equal(formatPrice(0), fr(0)));
test('formatPrice : centimes seuls', () => assert.equal(formatPrice(7), fr(0.07)));
