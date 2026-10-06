# Corriger la page de paiement Lumio Shop

Ce dépôt contient la page de paiement de Lumio Shop (`src/`), avec son module de calcul
(`src/cart.js`). Les tests (`npm test`) échouent, et le service client remonte ces retours :

> « Le total de mon panier est faux, et le montant de chaque ligne ne change pas avec la quantité. »
> « Quand je clique sur + pour un article, c'est un autre article qui augmente. Sur le dernier, rien ne se passe. »
> « J'ai voulu retirer un article, deux ont disparu. »
> « Mon code promo est accepté mais le total ne bouge pas. »
> « Sur mon téléphone, la page déborde sur le côté. »
> « Le bouton Payer est quasiment illisible. »
> « Je navigue au clavier : je ne vois pas où je suis. »

Corrige la page et le module pour que **tout** ce que décrit le `README.md` (calcul et page) soit
respecté. Les tests fournis ne couvrent pas toute la spécification : c'est le README qui fait foi.

Contraintes :
- Ne modifie pas les tests existants dans `test/` (tu peux en ajouter dans d'autres fichiers).
- Garde la même API publique de `src/cart.js` (mêmes fonctions, mêmes signatures).
- Pas de nouvelle dépendance. `npm install && npm run build` doit toujours produire `dist/index.html`.
- Explique en quelques lignes dans le `README.md`, section « Corrections », ce que tu as corrigé.
