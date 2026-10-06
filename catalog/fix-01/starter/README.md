# Lumio Shop · page de paiement

Page de paiement d'une boutique fictive : panier, code promo, récapitulatif. Tous les montants sont
en **centimes** (entiers) dans le code.

## Spécification du calcul (`src/cart.js`)

- `subtotal(items)` : somme de `unitPrice × quantity` pour chaque ligne `{ name, unitPrice, quantity }`.
  Une ligne de quantité 0 ne compte pas.
- `applyDiscount(cents, code)` : applique un code promo.
  - `BIENVENUE10` : −10 % ; c'est le **montant après remise** (`cents × 90 / 100`) qui est arrondi
    au centime le plus proche, 0,5 vers le haut (1005 → 904,5 → **905**) ;
  - `MOINS5` : −500 centimes ;
  - le résultat n'est **jamais négatif** (minimum 0) ;
  - les codes sont insensibles à la casse (`bienvenue10` fonctionne) ;
  - sans code (`undefined` ou `null`) : montant inchangé ;
  - code inconnu : lève une erreur `Code promo inconnu`.
- `withVat(cents, rate = 0.2)` : montant TTC, arrondi au centime le plus proche (0,5 vers le haut).
- `total(items, code)` : sous-total → remise → TVA à 20 %.
- `formatPrice(cents)` : même format que `Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })`,
  par exemple `1 234,50 €`.

## Spécification de la page (`src/`)

- Chaque ligne affiche le prix unitaire et le **total de la ligne** (prix × quantité).
- `+` et `−` changent la quantité **de cette ligne uniquement** (minimum 1). « Retirer » supprime
  **cette ligne uniquement**.
- Appliquer un code promo valide met **immédiatement** à jour la remise, la TVA, le total et le
  bouton « Payer ». Un code inconnu affiche « Code promo inconnu. » et ne change pas le total.
- Le bouton « Payer » affiche le total TTC.
- Les boutons gardent leurs libellés visibles : `+`, `−`, « Retirer », « Appliquer », « Payer … ».
- Responsive : utilisable de 375 px à 1440 px de large, **sans défilement horizontal**.
- Accessible : contrastes suffisants (WCAG AA), focus clavier **visible** sur tous les éléments
  interactifs.
- Aucune erreur dans la console du navigateur.

## Commandes

```sh
npm install
npm run build   # site statique dans dist/
npm test
```
