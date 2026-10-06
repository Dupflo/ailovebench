# Vidéo de lancement : Lumio

Crée une **vidéo de motion design de 10 secondes** pour le lancement de **Lumio**, une application
mobile **fictive** de suivi d'habitudes.

## Contenu attendu (dans cet ordre)

1. Le nom **Lumio** apparaît avec une animation de titre (typographie cinétique).
2. Le slogan **« Construis tes habitudes, un jour à la fois »**.
3. Trois mots-clés animés l'un après l'autre : **Rappels**, **Séries**, **Statistiques**.
4. Un final : logo ou nom Lumio + **« Bientôt disponible »**.

## Exigences

- Animation fluide et soignée, transitions entre les parties ; texte lisible.
- Pas d'écran noir ni d'image figée de plus d'une seconde (le final peut tenir, mais doit rester vivant).
- Aucune ressource externe (polices, images, CDN) : tout est généré ou servi localement.
- Format : **MP4 H.264, 1920×1080, 30 images/s, durée 10 s** (entre 9,5 et 10,5 s). Le son est facultatif.

## Contrat de livraison

- `npm install && npm run build` produit `dist/lumio.mp4` (la vidéo) et `dist/index.html`, une page qui
  lit la vidéo (balise `<video>`, lecture en boucle, sans son ou en sourdine).
- Outils libres : canvas, Remotion, HyperFrames, Playwright + ffmpeg… `ffmpeg` est disponible dans le
  PATH de la machine. La vidéo peut être rendue pendant le build ou à l'avance et copiée par le build.
- Ajoute un `README.md` court : outil choisi, commandes, choix faits.
