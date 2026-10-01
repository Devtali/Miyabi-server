# 🎀 Miyabi Server — Assistant IA WhatsApp

Serveur Node.js (Express + Socket.io + Baileys) intégrant le bot WhatsApp **Miyabi** propulsé par Gemini AI (`gemini-2.5-flash`), avec téléchargement de musique/vidéo, recherche web, gestion de groupes et fiches joueurs RPG.

---

## 📋 Prérequis (Pour toute plateforme : Windows, macOS, Linux, VPS)

- **Node.js** version 18 ou supérieure (recommandé : **Node.js 20+**)
- **npm** (inclus avec Node.js)
- *(Optionnel mais recommandé pour les audios)* **FFmpeg** :
  - Ubuntu/Debian : `sudo apt install ffmpeg`
  - macOS : `brew install ffmpeg`
  - Windows : `winget install Gyan.FFmpeg` ou via choco

---

## 🚀 Installation & Lancement

1. **Cloner le projet** :
   ```bash
   git clone <URL_DU_REPO_GITHUB>
   cd miyabi-server
   ```

2. **Installer les dépendances** :
   ```bash
   npm install
   ```

3. **Créer le fichier de configuration `.env`** :
   ```bash
   cp .env.example .env
   ```

4. **Configurer `.env`** :
   Ouvre `.env` et renseigne tes informations (voir section ci-dessous).

5. **Démarrer le serveur** :
   ```bash
   npm start
   ```

6. **Ouvrir l'interface dans le navigateur** :
   - Rends-toi sur `http://localhost:3000`
   - Clique sur **Générer le QR code** (ou utilise le code d'association par numéro)
   - Depuis WhatsApp sur ton téléphone : **Menu (⋮) > Appareils connectés > Connecter un appareil**, puis scanne le QR code.

---

## ⚙️ Variables d'environnement (`.env`)

```env
PORT=3000
BOT_NAME=Miyabi
OWNER_NUMBER=237XXXXXXXXX
MOTHER_NUMBER=237XXXXXXXXX
SEND_STICKERS=true
WALLET_GROUP_ID=

# Clé Gemini principale (formats acceptés : AQ.Ab8... ou AIzaSy...)
GEMINI_API_KEY=AQ.Ab8...

# Clés secondaires optionnelles (rotation automatique si quota atteint)
GEMINI_API_KEY_1=
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=
GEMINI_API_KEY_4=
```

> 💡 **Formats de clés Gemini supportés :**
> - Les nouvelles clés Google AI Studio / Cloud sous format `AQ.Ab8...`
> - Les clés Google standards sous format `AIzaSy...`
> - Le bot gère automatiquement le basculement (rotation) entre les clés en cas de limite de requêtes par minute (HTTP 429).

---

## 🌐 Endpoints de l'API

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/connect` | Initie une session Baileys (QR code ou code d'association) |
| GET | `/api/qr/:sessionId` | Récupère le QR code généré |
| GET | `/api/status/:sessionId` | Vérifie le statut de la session |
| GET | `/api/session/active` | Indique si une session active/connectée existe déjà |
| POST | `/api/session/delete` | Supprime définitivement la session et réinitialise les clés |
| POST | `/api/disconnect` | Déconnecte la session active |

---

## 🔒 Sécurité & Confidentialité GitHub

Le fichier `.gitignore` protège automatiquement tes données sensibles :
- `.env` et clés API
- `sessions/` (identifiants de connexion WhatsApp)
- `data/` (fichiers JSON locaux et soldes)
- `temp/` (fichiers temporaires)

---

## 🔄 Déploiement en ligne (VPS, Railway, Render)

1. Publie ton dépôt sur GitHub.
2. Crée un nouveau projet Web Service sur Railway ou Render connecté à ton dépôt GitHub.
3. Renseigne les variables d'environnement définies dans `.env.example` dans les paramètres du dashboard.
4. Lance le déploiement ! Le serveur écoute automatiquement sur `PORT` (par exemple 8080 ou 3000).
