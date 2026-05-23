const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Import des handlers Miyabi
const messageHandler = require('../handlers/messageHandler');
const personality = require('./personality');

const SESSIONS_DIR = path.join(__dirname, '../../sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Map des sessions actives : sessionId → { sock, status, phone }
const activeSessions = new Map();

class SessionManager {
    constructor(io) {
        this.io = io; // Socket.io pour envoyer les events au frontend
    }

    // ──────────────────────────────────────────────
    // Créer ou reprendre une session
    // ──────────────────────────────────────────────
    async createSession(sessionId, phoneNumber) {
        if (activeSessions.has(sessionId)) {
            const existing = activeSessions.get(sessionId);
            if (existing.status === 'connected') {
                return { success: false, error: 'already_connected' };
            }

            try { existing.sock?.end(); } catch (e) {}
            activeSessions.delete(sessionId);
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        // Initialiser l'authentification avec Baileys
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            qrTimeout: 60_000 // 60 secondes pour le code d'appairage
        });

        // Stocker la session
        activeSessions.set(sessionId, {
            sock,
            status: 'pending',
            phone: phoneNumber,
            pairingCode: null,
            pairingCodeExpiresAt: null,
            createdAt: Date.now()
        });

        // ── Events de connexion ──
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Envoyer le QR code au frontend via Socket.io
                this.io.to(sessionId).emit('qr', { qr });
                this._updateStatus(sessionId, 'qr_ready');
            }

            if (connection === 'open') {
                this._updateStatus(sessionId, 'connected');
                this._updatePairingCode(sessionId, null);
                this.io.to(sessionId).emit('connected', {
                    message: '✅ Miyabi est connectée !',
                    phone: phoneNumber
                });

                // Message de bienvenue à l'utilisateur
                try {
                    await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
                        text: `...Je suis là. T'as payé pour ça alors je vais faire mon travail. Envoie-moi un message pour commencer.`
                    });
                } catch (e) {}
            }

            if (connection === 'close') {
                const currentSession = activeSessions.get(sessionId);
                if (currentSession?.sock !== sock) return;

                const code = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode : null;

                if (code === DisconnectReason.loggedOut) {
                    this._updateStatus(sessionId, 'logged_out');
                    this.io.to(sessionId).emit('disconnected', { reason: 'logged_out' });
                    this.deleteSession(sessionId);
                } else {
                    this._updateStatus(sessionId, 'reconnecting');
                    this.io.to(sessionId).emit('reconnecting');
                    setTimeout(() => this.createSession(sessionId, phoneNumber), 5000);
                }
            }
        });

        // ── Messages entrants ──
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                const isGroup = msg.key.remoteJid?.endsWith('@g.us');
                await messageHandler.handleMessage(sock, msg, isGroup);
            }
        });

        // ── Nouveaux membres groupe ──
        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            if (action === 'add') {
                for (const participant of participants) {
                    const number = participant.split('@')[0];
                    try {
                        await sock.sendMessage(id, {
                            text: `@${number} a rejoint. ...Bienvenue, j'imagine.`,
                            mentions: [participant]
                        });
                    } catch (e) {}
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Demander le pairing code si pas encore enregistré ──
        // Vérifier si on a déjà des credentials enregistrés
        const hasCreds = fs.existsSync(path.join(sessionPath, 'creds.json'));

        if (!hasCreds && phoneNumber) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const cleanPhone = phoneNumber.replace(/\D/g, '');
                const code = await sock.requestPairingCode(cleanPhone);
                this._updatePairingCode(sessionId, code, 180000);
                this.io.to(sessionId).emit('pairing_code', { code });
                this._updateStatus(sessionId, 'pairing');
                
                // Attendre la connexion avec timeout de 3 minutes
                try {
                    await sock.waitForConnectionUpdate(
                        async (update) => update.connection === 'open',
                        180000
                    );
                    this._updateStatus(sessionId, 'connected');
                    this.io.to(sessionId).emit('pairing_success');
                } catch (timeoutError) {
                    this._updateStatus(sessionId, 'pairing_failed');
                    this.io.to(sessionId).emit('error', { 
                        message: 'Timeout: Le code d\'appairage n\'a pas été confirmé après 3 minutes. Relance une connexion pour générer un nouveau code.' 
                    });
                    this.deleteSession(sessionId);
                    return { success: false, error: 'pairing_timeout' };
                }
                
                return { success: true, code };
            } catch (error) {
                this._updateStatus(sessionId, 'pairing_failed');
                this.io.to(sessionId).emit('error', {
                    message: `Appairage impossible: ${error.message || 'numéro invalide ou déjà connecté.'}`
                });
                this.deleteSession(sessionId);
                return { success: false, error: error.message };
            }
        }

        return { success: true };
    }

    // ──────────────────────────────────────────────
    // Supprimer une session (déconnexion)
    // ──────────────────────────────────────────────
    deleteSession(sessionId) {
        const session = activeSessions.get(sessionId);
        activeSessions.delete(sessionId);

        if (session?.sock) {
            try { session.sock.end(); } catch (e) {}
        }

        // Supprimer les fichiers de session
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    getSession(sessionId) {
        return activeSessions.get(sessionId);
    }

    getStatus(sessionId) {
        return activeSessions.get(sessionId)?.status || 'not_found';
    }

    replaySessionState(sessionId, socket) {
        const session = activeSessions.get(sessionId);
        if (!session) return false;

        const payload = { status: session.status };
        const pairingCodeIsValid = session.pairingCode &&
            session.pairingCodeExpiresAt &&
            Date.now() < session.pairingCodeExpiresAt;

        if (pairingCodeIsValid) {
            payload.pairingCode = session.pairingCode;
        }

        socket.emit('status_update', payload);

        if (pairingCodeIsValid) {
            socket.emit('pairing_code', { code: session.pairingCode });
        }

        return true;
    }

    _updateStatus(sessionId, status) {
        const session = activeSessions.get(sessionId);
        if (session) {
            session.status = status;
            activeSessions.set(sessionId, session);
        }
    }

    _updatePairingCode(sessionId, code, ttlMs = 0) {
        const session = activeSessions.get(sessionId);
        if (session) {
            session.pairingCode = code;
            session.pairingCodeExpiresAt = code ? Date.now() + ttlMs : null;
            activeSessions.set(sessionId, session);
        }
    }

    // Nettoyer les sessions inactives depuis + de 10 min
    cleanupStaleSessions() {
        const now = Date.now();
        for (const [id, session] of activeSessions.entries()) {
            if (session.status === 'pending' && now - session.createdAt > 600000) {
                this.deleteSession(id);
            }
        }
    }
}

module.exports = SessionManager;
