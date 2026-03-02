# Koh Lanta – Le Ftour des Aventuriers (MVP Backbone)

Backbone multi-joueurs **TV + téléphones + Admin** en temps réel avec Socket.IO.

## Stack
- Node.js HTTP server
- Socket.IO (websocket + polling fallback)
- Front statique HTML/CSS/JS
- QR code côté serveur (`/api/qr`)

> Note: le projet vise une architecture prête pour brancher des mini-jeux plus tard, sans les implémenter ici.

## Architecture

```txt
server.js
server/
  games/ (legacy, non utilisé par le backbone MVP)
public/
  index.html          # landing
  admin.html          # game master
  tv.html             # spectator 16:9
  join.html           # player mobile
  style.css           # design system Koh Lanta
```

## Routes
- `/` : landing
- `/admin/NEW` : création room
- `/admin/:roomCode` : dashboard room
- `/tv/:roomCode` : TV spectator
- `/join` : join manuel
- `/join/:roomCode` : join via QR/lien public
- `/api/qr?data=<url>` : QR png
- `/healthz` : probe

## Variables d'environnement
- `PORT` (default `3000`)
- `ADMIN_KEY` (obligatoire en prod)
- `PUBLIC_BASE_URL` (ex: `https://mon-domaine.com`)
- `CORS_ORIGIN` (ex: `https://mon-domaine.com`)

Exemple:
```bash
PORT=3000
ADMIN_KEY="super-secret"
PUBLIC_BASE_URL="https://mon-domaine.com"
CORS_ORIGIN="https://mon-domaine.com"
```

## Démarrage local
```bash
npm install
ADMIN_KEY="dev-key" PUBLIC_BASE_URL="http://localhost:3000" npm start
```

## Déploiement Internet (WebSocket compatible)

### Option recommandée: Render / Fly / Railway
1. Push du repo sur GitHub.
2. Créer un service Node.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Configurer env vars:
   - `ADMIN_KEY`
   - `PUBLIC_BASE_URL`
   - `CORS_ORIGIN`
6. Vérifier `https://votre-domaine/healthz`.
7. Ouvrir `/admin/NEW`, créer room, afficher `/tv/:roomCode`, scanner le QR.

### Notes Vercel
Vercel est moins adapté pour Socket.IO stateful en mémoire. Préférer Render/Fly/Railway pour ce MVP.

## Schéma de données

### Room
```ts
{
  roomCode: string;
  createdAt: string;
  updatedAt: string;
  locked: boolean;
  screen: 'LOBBY' | 'WAITING' | 'PLACEHOLDER';
  players: Map<playerId, Player>;
  adminSocketId: string | null;
}
```

### Player
```ts
{
  playerId: string;
  reconnectToken: string;
  name: string;
  avatar: string;
  ready: boolean;
  status: 'CONNECTED' | 'DISCONNECTED';
  lastSeenAt: string;
}
```

## Socket.IO events

### Client -> Server
- `room:create` `{ adminKey }`
- `admin:auth` `{ adminKey, roomCode }`
- `room:join` `{ roomCode, playerId?, reconnectToken?, name, avatar }`
- `room:leave` `{ roomCode, playerId }`
- `player:update` `{ roomCode, playerId, name?, avatar?, ready? }`
- `admin:lock` `{ roomCode, locked }`
- `admin:kick` `{ roomCode, playerId }`
- `admin:reset` `{ roomCode }`
- `tv:screen` `{ roomCode, screen }`
- `tv:subscribe` `{ roomCode }`

### Server -> Clients
- `tv:state` (snapshot room + roster)
- `presence:update` `{ roomCode, playerId, status, lastSeenAt }`
- `admin:revoked`

## UX/UI Koh Lanta
- Palette jungle + terre + torches
- Cartes immersives “campement”
- Flicker torche + grain discret
- Lisibilité TV à distance et mobile faible lumière
- Assets visuels prévus via `url('/Visuels/...')` (si présents dans `public/Visuels`)

## Extensibilité mini-jeux
La clé d’extension est l’état `screen` (et les events admin). On peut ajouter plus tard:
- registre de mini-jeux
- état de manche par room
- channels d’events dédiés par mini-jeu
sans casser les flux lobby/admin/tv/player.
