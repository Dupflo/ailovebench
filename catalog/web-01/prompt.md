# Landing page : Lumio

Crée la landing page de **Lumio**, une application mobile **fictive** de suivi d'habitudes
(« Construis tes habitudes, un jour à la fois »).

## Contenu attendu

1. **Hero** : titre, sous-titre, bouton d'appel à l'action « Essayer gratuitement » et un visuel
   d'illustration (SVG ou CSS, aucune image externe).
2. **Fonctionnalités** : au moins 3 blocs (icône, titre, texte court).
3. **Comment ça marche** : 3 étapes numérotées.
4. **Tarifs** : 3 offres (Gratuit, Plus à 4 €/mois, Équipe à 12 €/mois), l'offre Plus mise en avant.
5. **Témoignages** : 3 avis inventés (prénoms fictifs).
6. **FAQ** : au moins 4 questions, sous forme d'accordéon qui s'ouvre et se ferme.
7. **Pied de page** : liens (Mentions légales, Contact, Confidentialité) et copyright.

## Exigences

- Responsive : lisible et sans défilement horizontal de 375 px à 1440 px de large.
- Accessible : contrastes suffisants, titres hiérarchisés, textes alternatifs, navigation au clavier
  (l'accordéon de la FAQ doit fonctionner au clavier).
- Aucune erreur dans la console du navigateur.
- Aucune ressource externe (polices, images, scripts, CDN) : tout doit être servi localement.
- Langue de la page : français.

## Contrat de livraison

- Le projet doit se construire avec `npm install && npm run build`.
- Le build doit produire un site statique dans `dist/`, avec `dist/index.html` comme point d'entrée.
- La stack est libre (HTML/CSS/JS, Vite, framework…), tant que ce contrat est respecté.
- Ajoute un `README.md` court : stack choisie, commandes, choix faits.
