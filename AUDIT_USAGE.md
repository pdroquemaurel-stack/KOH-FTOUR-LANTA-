# Audit orienté usage — Party Buzzer

Date: 2026-02-19
Périmètre: `server.js`, `server/games/*`, `public/*`, `public/js/*`, `package.json`.

## Méthode rapide
- Revue statique du flux serveur Socket.IO + pages TV/mobile.
- Focus sur: stabilité, UX mobile, performance perçue, sécurité basique, déploiement simple.
- Priorisation par **impact utilisateur** puis **difficulté d’implémentation**.

---

## Top 10 priorisé (impact / difficulté)

| # | Sujet | Impact | Difficulté | Pourquoi c’est prioritaire | Suggestion concrète |
|---|---|---|---|---|---|
| 1 | **Sécuriser le rôle TV/admin** | Très élevé | Moyen | N’importe quel client peut devenir `tv` via `tv:create_room`, sans secret ni authentification. | Ajouter un `adminToken` (PIN court + hash en mémoire), le vérifier sur tous les events admin (`mode:set`, `scores:reset`, `quiz:start`, etc.). |
| 2 | **Valider et borner le code de salle** | Élevé | Faible | `tv:create_room` accepte une valeur libre et peut créer des salles illimitées (risque mémoire/DoS). | Limiter à `[A-Z0-9]{4,8}`, sinon refuser. Ajouter rate-limit simple par IP/socket sur création/join. |
| 3 | **Ajouter un nettoyage des salles inactives** | Élevé | Faible | Les salles restent en mémoire sans TTL, même après départ des joueurs/admin. | Stocker `updatedAt`, purger périodiquement les salles vides depuis >30 min. |
| 4 | **Corriger l’ajustement manuel des scores côté TV** | Élevé | Faible | Le front émet `scores:adjust`, mais le serveur ne gère pas cet event => bouton trompeur et état incohérent. | Implémenter `scores:adjust` côté serveur (avec bornes), ou retirer les boutons du front tant que non supporté. |
| 5 | **Passer en anti-traversée de chemin robuste** | Élevé | Faible | Le filtrage actuel de chemin est partiel; mieux vaut une vérification canonique stricte. | Utiliser `resolved = path.resolve(publicDir, '.' + urlPath)` puis refuser si `!resolved.startsWith(publicDir + path.sep)`. |
| 6 | **Réduire la latence perçue mobile (join)** | Moyen/Élevé | Faible | Le join dépend d’un script inline volumineux et d’UI bloquante (`overflow:hidden`, overlays, timers). | Extraire JS dans `public/js/join.js`, éviter blocage scroll global en mobile, rendre boutons “pending” explicites. |
| 7 | **Retirer la dépendance QR externe en runtime** | Moyen | Faible | Le QR charge depuis `api.qrserver.com`; en réseau filtré, le join devient moins fluide. | Générer QR côté client (lib locale) ou fallback “copier le lien” visible et actionnable. |
| 8 | **Améliorer cache HTTP et compression** | Moyen | Faible/Moyen | Les assets statiques sont relus disque à chaque requête, sans `Cache-Control` ni ETag/gzip. | Ajouter en-têtes cache (long pour assets versionnés), ETag/Last-Modified, compression gzip/br (proxy ou middleware). |
| 9 | **Stabiliser les flux de jeu concurrents** | Moyen | Moyen | Plusieurs events peuvent se télescoper (reset, close, start) sans “state machine” explicite. | Formaliser états (`idle`, `countdown`, `open`, `review`) et rejeter transitions invalides de façon centralisée. |
| 10 | **Simplifier le déploiement reproductible** | Moyen | Faible | Pas de lockfile, pas de script de vérification, pas de guide de déploiement clair. | Commit `package-lock.json`, ajouter `npm run check`, README “deploy 5 min” (Render/Fly/Railway) + variables d’env. |

---

## Quick wins (à faire en 1 journée)

1. **Implémenter `scores:adjust` côté serveur** (ou masquer les boutons).  
2. **Valider strictement `roomCode`** + longueur max dès `tv:create_room` et `player:join`.  
3. **Purger les salles vides** via intervalle toutes les 5 min.  
4. **Ajouter fallback join-link** (bouton copier) quand QR indisponible.  
5. **Commit `package-lock.json`** pour activer `npm audit` et déploiement déterministe.  
6. **Ajouter headers de sécurité minimum**: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.  

---

## Suggestions concrètes par axe

### 1) Stabilité
- Créer une utilité serveur `assertTv(socket, roomCode)` pour centraliser les contrôles admin.
- Ajouter un `maxPlayers` par salle et réponse d’erreur claire côté join.
- Logguer les transitions de jeu importantes (`start/close/reset`) avec `roomCode` et timestamp.

### 2) UX mobile
- Autoriser le scroll vertical sur la vue join (clavier mobile + petits écrans).
- Ajouter état visuel réseau: “connexion… / reconnecté / hors-ligne”.
- Pré-remplissage plus robuste du pseudo (localStorage) + feedback haptique léger au buzz.

### 3) Performance perçue
- Précharger les ressources critiques (`style.css`, scripts principaux).
- Limiter le nombre d’updates UI pendant `guess:progress` (throttle 100–200ms côté client).
- Éviter les recalculs DOM complets du scoreboard sur chaque petit changement (patch ciblé par joueur).

### 4) Sécurité basique
- Ajouter protection anti-spam par socket (`buzz:press`, `answer`): token bucket simple.
- Mettre `cors.origin` configurable via variable d’environnement en prod.
- Ajouter taille max payload Socket.IO (et validation schéma minimale des events).

### 5) Déploiement simple
- Ajouter README “run local / prod”.
- Ajouter endpoint `/healthz` (200 OK) pour plateformes PaaS.
- Ajouter `Dockerfile` minimal (optionnel) pour portabilité.

---

## Plan d’exécution recommandé (ordre)

**Semaine 1 (risque immédiat)**
1. Auth admin + validation room code.  
2. Fix `scores:adjust` + purge salles inactives.  
3. Lockfile + check script.

**Semaine 2 (expérience utilisateur)**
4. Fallback QR + états réseau mobile.  
5. Scroll/mobile polish + réduction du JS inline join.

**Semaine 3 (robustesse/perfs)**
6. Cache/compression + state machine de transitions.  
7. Rate limit events + headers sécurité.

---

## Score synthétique actuel (sur 10)
- **Stabilité:** 6.5/10
- **UX mobile:** 6/10
- **Performance perçue:** 6/10
- **Sécurité basique:** 4.5/10
- **Déploiement simple:** 5/10

Global: **5.6/10** (prototype solide, mais priorités sécurité/stabilité à traiter avant usage public intensif).
