# Plan d'adaptation — Koh Lanta: Le Ftour des Aventuriers

## Structure & stack
- Serveur Node + Socket.IO (`server.js`)
- Moteurs de jeux `server/games/*`
- TV admin: `public/tv.html` + `public/js/tv-*.js`
- Joueur mobile: `public/join.html`

## Wireflow TV (animateur)
1. Accueil room + QR
2. Ice breaker (most)
3. Quiz rapidité
4. Prix Juste
5. Top 3
6. Duel partager/trahir
7. Conseil (vote secret + immunité)
8. Finale/podium via scoreboard live

## Wireflow Mobile (joueur)
1. Join room + pseudo
2. Attente d'épreuve
3. Réponses/votes selon mode
4. Retour état d'attente + score live

## Nouveaux modes
- `top3`: 3 réponses texte, scoring + bonus
- `duel`: appariement auto, 3 rounds max, support impair via bye/Djinn
- `conseil`: vote secret, option immunité, mode malus ou élimination

## Scoring implémenté
- Ice breaker: +1 vote gagnant, +2 personne la plus votée
- Quiz rapidité: +2 bonne réponse, +1 plus rapide
- Prix juste: +3 premier, +1 second, -1 dépassement
- Top3: +1 par bonne réponse, +2 bonus 3/3
- Duel: payoff standard partager/trahir

## Déploiement
- `npm install`
- `npm start`
- Ouvrir `http://<ip-locale>:3000/tv.html?new=1`
- Joueurs: `http://<ip-locale>:3000/join`
