# Koh Lanta – Le Ftour des Aventuriers (Version simplifiée)

## Concept
Application temps réel **session unique** (une seule salle globale) avec 3 vues:
- `/` choix **ADMIN** ou **AVENTURIER**
- `/admin` console admin (mot de passe: `Admin`)
- `/join` entrée aventurier (nom + animal fétiche)
- `/tv` affichage TV

## Lancement
```bash
npm install
npm start
```

## Variables d'environnement
- `PORT` (défaut: 3000)
- `CORS_ORIGIN` (défaut: `*`)

## Socket.IO (session unique)
Client -> serveur:
- `admin:auth` `{ password }`
- `room:join` `{ playerId?, reconnectToken?, name, animal }`
- `player:update` `{ playerId, name?, animal?, ready? }`
- `admin:lock` `{ locked }`
- `admin:kick` `{ playerId }`
- `admin:reset` `{}`
- `tv:screen` `{ screen: 'LOBBY'|'WAITING'|'PLACEHOLDER' }`

Serveur -> clients:
- `tv:state` état global
- `presence:update` état d'un joueur
- `admin:revoked`

## Reconnexion
Le joueur est persisté en localStorage (`playerId + reconnectToken`).
