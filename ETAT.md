# État — distribution-aides-de-jeu

- 1.0.0 (2026-10-13) : première version. Fenêtre du Gardien, remise image / page / journal, copie dans le journal de bord (flag `distribution-aides-de-jeu.received` / `.note` sur la page), accès en lecture facultatif, apparition animée 1933 / moderne par socket, trace chat privée, API `open()` / `distribute()`.
- Journaux de bord du monde : dossier « JOURNAL DE BORD [Joueurs] », un « Journal de Bord [Personnage] » par joueur (propriétaire).
- 1.1.0 (2026-10-14) : fusion du module « Zoom & Pan sur les images » (scripts/zoom.js) : zoom, déplacement, pings, vue forcée par le Gardien, sur les ImagePopout et dans l'apparition (+ bouton « Ouvrir en grand »). Réglage `zoom`. Messages socket `zoomPing` / `zoomView`.
- 1.4.0 (2026-10-18) : séparation 1933 / 2026. Réglage `logbookFolderModern` (défaut : dossier « Carnet de bord… »). `eraOf(handout)` lit l'époque dans les dossiers parents (19xx / 202x-203x) ou le chemin de l'image, sinon Bascule. Sélecteur « Époque » dans la fenêtre ; il choisit le carnet, le nom du carnet créé et l'animation (si style auto).
