# Système solaire en 3D

Crée une page web qui affiche un **système solaire animé en 3D** avec **Three.js**.

## Contenu attendu

1. Un **Soleil** lumineux au centre, qui éclaire la scène.
2. Au moins **5 planètes** de tailles et de couleurs différentes, qui tournent autour du Soleil à
   des vitesses différentes (les plus éloignées plus lentement) et tournent aussi sur elles-mêmes.
3. Au moins **une lune** qui tourne autour de sa planète.
4. Les **orbites** visibles (cercles fins).
5. Un **fond étoilé**.
6. Une **caméra orbitale** : glisser à la souris fait tourner la vue, la molette zoome.
7. Un **bouton pause / lecture** de l'animation, visible par-dessus la scène.

## Exigences

- La scène occupe toute la fenêtre et s'adapte au redimensionnement (de 375 px à 1440 px de large).
- Animation fluide.
- Aucune erreur dans la console du navigateur.
- Aucune ressource externe (CDN, textures distantes, polices) : Three.js est installé via npm et
  tout est servi localement. Les textures, s'il y en a, sont générées dans le code.

## Contrat de livraison

- Le projet doit se construire avec `npm install && npm run build`.
- Le build doit produire un site statique dans `dist/`, avec `dist/index.html` comme point d'entrée.
- Outil de build libre (Vite, esbuild…), tant que ce contrat est respecté.
- Ajoute un `README.md` court : stack choisie, commandes, choix faits.
