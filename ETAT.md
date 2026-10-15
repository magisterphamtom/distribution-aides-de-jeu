# État — distribution-aides-de-jeu

- 1.0.0 (2026-10-13) : première version. Fenêtre du Gardien, remise image / page / journal, copie dans le journal de bord (flag `distribution-aides-de-jeu.received` / `.note` sur la page), accès en lecture facultatif, apparition animée 1933 / moderne par socket, trace chat privée, API `open()` / `distribute()`.
- Journaux de bord du monde : dossier « JOURNAL DE BORD [Joueurs] », un « Journal de Bord [Personnage] » par joueur (propriétaire).
- 1.1.0 (2026-10-14) : fusion du module « Zoom & Pan sur les images » (scripts/zoom.js) : zoom, déplacement, pings, vue forcée par le Gardien, sur les ImagePopout et dans l'apparition (+ bouton « Ouvrir en grand »). Réglage `zoom`. Messages socket `zoomPing` / `zoomView`.
