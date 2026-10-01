const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    isJidStatusBroadcast
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');

const messageHandler = require('../handlers/messageHandler');
const logger = require('../utils/logger');

const SESSIONS_DIR = path.join(__dirname, '../../sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Caches recommandés par la documentation officielle Baileys (baileys.wiki) ──
// 1. Cache pour éviter les boucles infinies de retry de messages
const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// 2. Cache pour les métadonnées de groupe (évite les requêtes réseau excessives)
const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// 3. Store en mémoire pour getMessage (indispensable pour les retries et le déchiffrement Signal)
const messageStore = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

const activeSessions = new Map();

class SessionManager {
    constructor(io) {
        this.io = io;
        this.phoneIndex = new Map();
        this.reconnectAttempts = new Map();
    }

    async createSession(sessionId, phoneNumber = null, usePairingCode = false) {
        // Fermer toute autre session non connectée pour éviter les conflits de clés Signal et Bad MAC
        for (const [id, s] of activeSessions.entries()) {
            if (id !== sessionId && s.status !== 'connected') {
                logger.info(`Nettoyage ancienne session en attente: ${id}`);
                this.deleteSession(id);
            }
        }

        if (activeSessions.has(sessionId)) {
            const existing = activeSessions.get(sessionId);
            if (existing.status === 'connected') {
                return { success: false, error: 'already_connected' };
            }
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Récupérer dynamiquement la dernière version supportée de WhatsApp Web
        let version;
        try {
            const vInfo = await fetchLatestBaileysVersion();
            version = vInfo.version;
            logger.info(`📱 Baileys version WhatsApp Web: ${version.join('.')}`);
        } catch (e) {
            version = [2, 3000, 1043857760];
            logger.warn(`📱 Baileys version fallback: ${version.join('.')}`);
        }

        // Configuration alignée avec les recommandations officielles de baileys.wiki
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),

            // Optimisation bot : Ne pas télécharger tout l'historique ancien pour économiser RAM et temps
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,

            // Ignorer les messages de statuts et diffusions qui causent des Bad MAC récurrents
            shouldIgnoreJid: (jid) => isJidStatusBroadcast(jid) || (typeof jid === 'string' && (jid.endsWith('@broadcast') || jid.includes('broadcast'))),

            // Permettre au téléphone principal de continuer à recevoir les notifications push
            markOnlineOnConnect: false,

            // Cache des tentatives de messages pour éviter les boucles infinies
            msgRetryCounterCache,

            // Résolution des messages pour les retries et votes (anti Bad MAC / waiting message)
            getMessage: async (key) => {
                if (key?.id) {
                    const cached = messageStore.get(key.id);
                    if (cached) return cached;
                }
                return undefined;
            },

            // Cache des métadonnées de groupe (réduit de 90% les appels réseau en groupe)
            cachedGroupMetadata: async (jid) => {
                return groupCache.get(jid);
            },

            // Prévisualisation des liens de haute qualité
            generateHighQualityLinkPreview: true,

            // Timeouts réseau résilients
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });

        const session = {
            sock,
            status: 'pending',
            phone: phoneNumber,
            lastQR: null,
            lastPairingCode: null,
            createdAt: Date.now()
        };

        activeSessions.set(sessionId, session);

        if (phoneNumber) {
            this.phoneIndex.set(phoneNumber, sessionId);
        }

        // Code d'appairage par numéro si demandé
        if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    logger.info(`🔐 Pairing code généré pour ${sessionId}: ${code}`);
                    session.lastPairingCode = code;
                    this.io.to(sessionId).emit('pairing_code', { code });
                    this._updateStatus(sessionId, 'code_ready');
                } catch (err) {
                    logger.error(`Erreur pairing code: ${err.message}`);
                    this.io.to(sessionId).emit('error', { message: 'Erreur code d\'appairage: ' + err.message });
                }
            }, 1500);
        }

        // ── Événements de connexion (baileys.wiki lifecycle) ──
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info(`✅ QR code reçu pour session: ${sessionId}`);
                session.lastQR = qr;
                this.io.to(sessionId).emit('qr', { qr });
                this._updateStatus(sessionId, 'qr_ready');
            }

            if (connection === 'open') {
                const userPhone = sock.user?.id ? sock.user.id.split(':')[0] : (phoneNumber || 'Inconnu');
                this.reconnectAttempts.delete(sessionId);
                this._updateStatus(sessionId, 'connected');
                logger.info(`🎉 Session ${sessionId} connectée avec succès (+${userPhone})`);

                this.io.to(sessionId).emit('connected', {
                    message: 'Miyabi est connectée !',
                    phone: userPhone
                });

                // Message de bienvenue initial
                try {
                    const targetJid = sock.user?.id
                        ? `${sock.user.id.split(':')[0]}@s.whatsapp.net`
                        : (phoneNumber ? `${phoneNumber}@s.whatsapp.net` : null);

                    if (targetJid) {
                        await sock.sendMessage(targetJid, {
                            text: `...Je suis là. T'as configuré le bot alors je vais faire mon travail. Envoie-moi un message pour commencer.`
                        });
                    }
                } catch (e) {}
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : lastDisconnect?.error?.statusCode;

                logger.warn(`⚠️ Connexion fermée (${sessionId}), code: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                    logger.info(`🚪 Session ${sessionId} déconnectée / session invalide`);
                    this._updateStatus(sessionId, 'logged_out');
                    this.io.to(sessionId).emit('disconnected', { reason: 'logged_out' });
                    this.deleteSession(sessionId);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    logger.info(`🔄 Redémarrage requis pour ${sessionId}, reconnexion immédiate...`);
                    this.createSession(sessionId, phoneNumber, usePairingCode);
                } else {
                    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
                    this.reconnectAttempts.set(sessionId, attempts);

                    const delay = Math.min(2000 * Math.pow(1.5, attempts - 1), 30000);
                    logger.info(`⏳ Tentative de reconnexion #${attempts} dans ${Math.round(delay / 1000)}s...`);

                    this._updateStatus(sessionId, 'reconnecting');
                    this.io.to(sessionId).emit('reconnecting', { attempt: attempts });

                    setTimeout(() => {
                        if (activeSessions.has(sessionId)) {
                            this.createSession(sessionId, phoneNumber, usePairingCode);
                        }
                    }, delay);
                }
            }
        });

        // ── Sauvegarde des identifiants d'authentification ──
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (e) {
                logger.error(`Erreur sauvegarde creds (${sessionId}): ${e.message}`);
            }
        });

        // ── Gestion du cache des métadonnées de groupe ──
        sock.ev.on('groups.update', async (groupUpdates) => {
            for (const update of groupUpdates) {
                const cached = groupCache.get(update.id);
                if (cached) {
                    groupCache.set(update.id, { ...cached, ...update });
                }
            }
        });

        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            const cached = groupCache.get(id);
            if (cached) {
                try {
                    const fresh = await sock.groupMetadata(id);
                    groupCache.set(id, fresh);
                } catch (e) {}
            }

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

        // ── Messages entrants avec mise en cache du message pour getMessage ──
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg || !msg.key) continue;

                // Enregistrer pour getMessage
                if (msg.key.id && msg.message) {
                    messageStore.set(msg.key.id, msg.message);
                }

                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;

                const isGroup = msg.key.remoteJid?.endsWith('@g.us');
                try {
                    await messageHandler.handleMessage(sock, msg, isGroup);
                } catch (handlerErr) {
                    logger.error(`Erreur handleMessage non capturée: ${handlerErr?.stack || handlerErr?.message || handlerErr}`);
                }
            }
        });

        return { success: true };
    }

    async deleteSession(sessionId) {
        const session = activeSessions.get(sessionId);
        if (session?.sock) {
            try {
                if (session.status === 'connected') {
                    await session.sock.logout().catch(() => {});
                }
            } catch (e) {}
            try { session.sock.end(); } catch (e) {}
        }
        activeSessions.delete(sessionId);
        this.reconnectAttempts.delete(sessionId);
        if (session?.phone) this.phoneIndex.delete(session.phone);

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            } catch (e) {}
        }
        this.io.to(sessionId).emit('session_deleted', { sessionId });
    }

    async deleteAllSessions() {
        const ids = Array.from(activeSessions.keys());
        for (const id of ids) {
            await this.deleteSession(id);
        }
        if (fs.existsSync(SESSIONS_DIR)) {
            try {
                for (const f of fs.readdirSync(SESSIONS_DIR)) {
                    fs.rmSync(path.join(SESSIONS_DIR, f), { recursive: true, force: true });
                }
            } catch (e) {}
        }
    }

    getActiveSession() {
        for (const [id, session] of activeSessions.entries()) {
            if (session.status === 'connected') {
                const phone = session.sock?.user?.id ? session.sock.user.id.split(':')[0] : (session.phone || 'Inconnu');
                return { sessionId: id, status: 'connected', phone };
            }
        }
        return null;
    }

    getSession(sessionId) { return activeSessions.get(sessionId); }

    getQR(sessionId) {
        return activeSessions.get(sessionId)?.lastQR || null;
    }

    getStatus(sessionId) {
        return activeSessions.get(sessionId)?.status || 'not_found';
    }

    _updateStatus(sessionId, status) {
        const session = activeSessions.get(sessionId);
        if (session) {
            session.status = status;
            activeSessions.set(sessionId, session);
        }
    }

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
module.exports.messageStore = messageStore;
module.exports.groupCache = groupCache;
