const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
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
const { inspectMessage } = require('../utils/messageSanitizer');

const SESSIONS_DIR = path.join(__dirname, '../../sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Caches recommandés par la documentation officielle Baileys (baileys.wiki) ──
// 1. Cache pour éviter les boucles infinies de retry de messages
const msgRetryCounterCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });

// 2. Cache pour les métadonnées de groupe (évite les requêtes réseau excessives)
const groupCache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });

// 3. Store en mémoire pour getMessage (indispensable pour les retries et le déchiffrement Signal)
const messageStore = new NodeCache({ stdTTL: 1800, checkperiod: 300, useClones: false });

const activeSessions = new Map();

// ── Paramètres du pairing code (logique inspirée de l'exemple SEN/NEXUS) ──
const PAIRING_DELAY_MS = 4000;      // laisser le socket s'initialiser avant de demander le code
const PAIRING_MAX_ATTEMPTS = 3;     // nb max de codes générés pour une même session
const MAX_RECONNECTS = 10;          // arrêt des reconnexions infinies
const formatPairingCode = (code) => code?.match(/.{1,4}/g)?.join('-') || code;

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

        // Si une ancienne socket existe pour ce sessionId (reconnexion), la fermer proprement
        const previous = activeSessions.get(sessionId);
        if (previous?.sock) {
            try { previous.sock.ev.removeAllListeners(); } catch (e) {}
            try { previous.sock.end(undefined); } catch (e) {}
        }

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
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
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
                const cached = groupCache.get(jid);
                if (cached) return cached;
                try {
                    const meta = await sock.groupMetadata(jid);
                    groupCache.set(jid, meta);
                    return meta;
                } catch (e) {
                    return undefined; // Baileys fera sa propre requête
                }
            },

            // Prévisualisation des liens de haute qualité
            generateHighQualityLinkPreview: true,

            // Timeouts réseau résilients
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000
        });

        const session = {
            sock,
            status: previous?.status === 'connected' ? 'pending' : (previous?.status || 'pending'),
            phone: phoneNumber,
            lastQR: null,
            lastPairingCode: previous?.lastPairingCode || null,
            pairingAttempts: previous?.pairingAttempts || 0,
            createdAt: previous?.createdAt || Date.now()
        };

        activeSessions.set(sessionId, session);

        if (phoneNumber) {
            this.phoneIndex.set(phoneNumber, sessionId);
        }

        // ── PAIRING CODE (logique de l'exemple : si non enregistré → demande après délai) ──
        if (usePairingCode && !sock.authState.creds.registered) {
            const cleanPhone = (phoneNumber || '').replace(/[^0-9]/g, '');

            if (!cleanPhone) {
                logger.error(`❌ Aucun numéro de pairing défini pour la session ${sessionId}`);
                this.io.to(sessionId).emit('error', { message: 'Numéro de téléphone manquant pour le code d\'appairage' });
            } else if (session.pairingAttempts >= PAIRING_MAX_ATTEMPTS) {
                logger.warn(`⛔ Trop de tentatives de pairing pour ${sessionId}`);
                this.io.to(sessionId).emit('error', { message: 'Trop de tentatives. Relance la génération du code.' });
                this.deleteSession(sessionId);
                return { success: false, error: 'too_many_attempts' };
            } else {
                logger.info(`⏳ Demande de pairing pour : ${cleanPhone}`);
                setTimeout(async () => {
                    // La session a pu être supprimée/remplacée pendant le délai
                    if (activeSessions.get(sessionId) !== session) return;
                    if (sock.authState.creds.registered) return;
                    try {
                        session.pairingAttempts++;
                        const raw = await sock.requestPairingCode(cleanPhone);
                        const code = formatPairingCode(raw);
                        logger.info(`✅ CODE DE JUMELAGE (${sessionId}) : ${code}`);
                        session.lastPairingCode = code;
                        this.io.to(sessionId).emit('pairing_code', { code });
                        this._updateStatus(sessionId, 'code_ready');
                    } catch (err) {
                        logger.error(`❌ Erreur pairing (vérifiez le numéro) : ${err.message}`);
                        this.io.to(sessionId).emit('error', { message: 'Erreur code d\'appairage : ' + err.message });
                    }
                }, PAIRING_DELAY_MS);
            }
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

                // Ignorer les évènements d'une ancienne socket déjà remplacée
                if (activeSessions.get(sessionId) !== session) return;

                if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                    logger.info(`🚪 Session ${sessionId} déconnectée / session invalide`);
                    this._updateStatus(sessionId, 'logged_out');
                    this.io.to(sessionId).emit('disconnected', { reason: 'logged_out' });
                    this.deleteSession(sessionId);
                } else if (statusCode === DisconnectReason.restartRequired) {
                    // Normal juste après un pairing réussi : on relance avec les creds enregistrés
                    logger.info(`🔄 Redémarrage requis pour ${sessionId}, reconnexion immédiate...`);
                    this.createSession(sessionId, phoneNumber, usePairingCode)
                        .catch(e => logger.error(`Reconnexion échouée (${sessionId}): ${e.message}`));
                } else {
                    const attempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
                    this.reconnectAttempts.set(sessionId, attempts);

                    if (attempts > MAX_RECONNECTS) {
                        logger.error(`⛔ ${sessionId} : trop d'échecs de reconnexion, abandon.`);
                        this.io.to(sessionId).emit('disconnected', { reason: 'max_reconnects' });
                        this.deleteSession(sessionId);
                        return;
                    }

                    const delay = Math.min(2000 * Math.pow(1.5, attempts - 1), 30000);
                    logger.info(`⏳ Tentative de reconnexion #${attempts} dans ${Math.round(delay / 1000)}s...`);

                    this._updateStatus(sessionId, 'reconnecting');
                    this.io.to(sessionId).emit('reconnecting', { attempt: attempts });

                    setTimeout(() => {
                        if (activeSessions.get(sessionId) === session) {
                            this.createSession(sessionId, phoneNumber, usePairingCode)
                                .catch(e => logger.error(`Reconnexion échouée (${sessionId}): ${e.message}`));
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
        sock.ev.on('groups.upsert', (groups) => {
            for (const g of groups) groupCache.set(g.id, g);
        });

        sock.ev.on('groups.update', async (groupUpdates) => {
            for (const update of groupUpdates) {
                const cached = groupCache.get(update.id);
                if (cached) {
                    groupCache.set(update.id, { ...cached, ...update });
                }
            }
        });

        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            // Participants modifiés : invalider, le cache se remplira à la prochaine demande
            groupCache.del(id);

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

                // ── SANITISATION : bloquer les messages toxiques avant tout traitement/stockage ──
                if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
                    const check = inspectMessage(msg);
                    if (check.suspicious) {
                        const from = msg.key.remoteJid;
                        logger.warn(`⚠️ [SANITIZER] Message suspect bloqué — De: ${msg.key.participant || from} — Raison: ${check.reason}`);
                        try {
                            if (msg.messageTimestamp) {
                                await sock.chatModify({
                                    deleteForMe: {
                                        deleteMedia: false,
                                        key: msg.key,
                                        timestamp: Number(msg.messageTimestamp)
                                    }
                                }, from);
                            }
                        } catch (e) {
                            logger.warn(`[SANITIZER] Suppression locale impossible : ${e.message}`);
                        }
                        continue;
                    }
                }

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
            if (['pending', 'qr_ready', 'code_ready', 'reconnecting'].includes(session.status) && now - session.createdAt > 600000) {
                this.deleteSession(id);
            }
        }
    }
}

module.exports = SessionManager;
module.exports.messageStore = messageStore;
module.exports.groupCache = groupCache;
