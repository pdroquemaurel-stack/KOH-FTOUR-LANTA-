# Koh Lanta — Le Ftour des Aventuriers

MVP temps réel **TV + mobiles + Admin** avec mini-jeux intégrés, Conseil et Finale.

## Dossiers
- `server.js` : serveur HTTP + Socket.IO + game engine
- `config/` : contenu éditable (questions/items/thèmes)
- `public/` : UI TV/Admin/Aventurier
- `public/Visuels/` : assets immersifs à uploader

> Note architecture POC: le runtime principal est `server.js` + pages `public/*.html`.
> Les fichiers `server/games/*` et `public/js/*` sont conservés comme legacy/référence.

## Routes
- `/` : choix ADMIN / AVENTURIER
- `/admin` : console game master (mot de passe `Admin`)
- `/join` : interface joueur
- `/tv` : écran TV

## State machine globale
`LOBBY -> INTRO -> GAME_A -> RESULTS_A -> GAME_B -> RESULTS_B -> GAME_C -> RESULTS_C -> GAME_D -> RESULTS_D -> GAME_E -> RESULTS_E -> GAME_G -> GAME_H -> GAME_I -> COUNCIL -> COUNCIL_RESULT -> FINAL -> FINAL_RESULT -> END`

## Contrôles Admin
Via `admin:command`:
- `START`, `NEXT`, `PAUSE`, `RESUME`, `SKIP`
- `RESET_PHASE`, `FORCE_END`
- `LOCK_ANSWERS`
- `SET_COUNCIL_MODE` (`ELIMINATION` / `PENALTY`)
- `SET_IMMUNITY` (collier)

## Mini-jeux implémentés
- **GAME_A** Susceptible de... vote joueur
- **GAME_B** Rapidité (fallback quiz)
- **GAME_C** Prix juste
- **GAME_D** Top 3 Maroc
- **GAME_E** Partager/Trahir (rounds)
- **GAME_G** Imposteurs
- **GAME_H** Totem caché (réactivité)
- **GAME_I** Porte cachée
- **COUNCIL** vote secret avec immunité
- **FINAL** mise (0-5) + question finale

## Config éditable (sans code)
- `config/susceptible_questions.json`
- `config/blindtest_bank.json`
- `config/priceisright_items.json`
- `config/top3_themes.json`

## Variables d'environnement
- `PORT` (default `3000`)
- `CORS_ORIGIN` (default `*`)
- `COUNCIL_MODE` (`ELIMINATION`|`PENALTY`)
- `COUNCIL_PENALTY` (default `5`)
- `FINALE_TOP` (default `3`)

## Lancer
```bash
npm install
npm start
```

## Socket events
Client -> server
- `admin:auth`, `admin:command`
- `room:join`, `player:update`
- `game:action`

Server -> clients
- `game:state`
- `results:publish`
- `presence:update`
- `admin:revoked`

## Checklist soirée 60 min (suggestion)
- Lobby + intro: 5 min
- Game A: 8 min
- Game B: 8 min
- Game C: 8 min
- Game D: 8 min
- Game E: 10 min
- Conseil: 7 min
- Finale + couronnement: 6 min

## Tests manuels recommandés
1. Ouvrir `/admin`, `/tv`, puis 3 mobiles sur `/join`.
2. Vérifier reconnexion (refresh mobile conserve identité et score).
3. Vérifier anti-triche: deuxième réponse même question refusée.
4. Vérifier lock answers (actions rejetées).
5. Vérifier Council immunity (votes ignorés contre immunisé).
6. Vérifier Finale (seuls finalistes peuvent répondre).

## Ajustements UI
- Admin simplifié: choisir un jeu, lancer le jeu sélectionné, puis gérer les scores joueurs.
- Admin peut modifier les scores en direct (+1/-1 ou valeur directe).
- TV immersive: fond `/public/Visuels/tv_background_main_1920x1080.webp`, question/règle en grand, scoreboard à droite, pseudos en vert quand le joueur a répondu.

## POC Jeu A
- Admin peut sélectionner et lancer `GAME_A` via `LAUNCH_GAME`.
- TV affiche en live qui a répondu et qui est en attente (`gameAProgress`).
- Fond TV: `Visuels/tv_background_main_1920x1080.webp`.

- Un joueur peut rejoindre en cours de partie et répondre immédiatement (POC GAME_A).
