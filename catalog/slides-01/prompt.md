# Deck de présentation : Lumio lève sa seed

Crée le deck de présentation (pitch investisseurs) de **Lumio**, une application mobile **fictive**
de suivi d'habitudes (« Construis tes habitudes, un jour à la fois »). Le deck est une page web
qui se présente en plein écran, slide par slide.

## Les 10 slides, dans cet ordre

1. **Titre** : « Lumio », le slogan, et « Pitch seed · octobre 2026 ».
2. **Le problème** : 3 constats courts (on abandonne ses bonnes résolutions en quelques semaines,
   les applis existantes culpabilisent, le suivi est trop fastidieux).
3. **La solution** : Lumio en une phrase et 3 bénéfices.
4. **Traction** : trois chiffres clés mis en valeur, exactement ceux-ci :
   **12 400** utilisateurs actifs mensuels, **42 %** de rétention à 30 jours, note moyenne **4,7/5**.
5. **Comment ça marche** : 3 étapes numérotées.
6. **Croissance** : un graphique des utilisateurs actifs mensuels, dessiné en SVG ou en canvas
   (pas d'image), avec ces valeurs : janvier 2 100, février 3 400, mars 5 200, avril 7 300,
   mai 9 800, juin 12 400. Les valeurs et les mois doivent être lisibles.
7. **Concurrence** : un tableau comparant Lumio à deux concurrents fictifs (HabitPro, DailyLoop)
   sur 4 critères (prix, rappels intelligents, mode hors ligne, sans publicité).
8. **Modèle économique** : 3 offres, Gratuit, Plus à 4 €/mois, Équipe à 12 €/mois.
9. **La levée** : 1,5 M€, répartis en 50 % produit, 30 % marketing, 20 % opérations.
10. **Merci** : un message de clôture et le contact `contact@lumio.example`.

## Exigences

- **Une slide à la fois** : seule la slide courante est visible à l'écran, au format 16:9.
- **Navigation au clavier** : flèche droite et Espace pour avancer, flèche gauche pour reculer.
  Sur la première slide, reculer ne fait rien ; sur la dernière, avancer ne fait rien.
- **Numéro de slide** visible en permanence, au format « 3 / 10 ».
- **Tout tient dans la slide** : aucun texte coupé, qui déborde ou sort de l'écran, quelle que soit
  la taille de la fenêtre (16:9, de 1280×720 à 1920×1080). La page elle-même ne défile pas.
- **Lisible** : aucun texte en dessous de 14 px à 1280×720, contrastes suffisants.
- Aucune erreur dans la console du navigateur.
- Aucune ressource externe (polices, images, scripts, CDN) : tout doit être servi localement.
- Langue de la page : français.

## Contrat de livraison

- Le projet doit se construire avec `npm install && npm run build`.
- Le build doit produire un site statique dans `dist/`, avec `dist/index.html` comme point d'entrée.
- Chaque slide est un élément HTML portant l'attribut `data-slide`, dans l'ordre du deck (10 au total).
- La stack est libre (HTML/CSS/JS, Vite, bibliothèque de slides installée en local…), tant que ce
  contrat est respecté.
- Ajoute un `README.md` court : stack choisie, commandes, choix faits.
