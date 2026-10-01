const express = require('express');
const router = express.Router();
const crypto = require('crypto');

let sessionManager;

function setSessionManager(sm) {
    sessionManager = sm;
}

// POST /api/connect — Initier une session (QR code officiel sans numéro requis)
router.post('/connect', async (req, res) => {
    try {
        const { phone, usePairingCode } = req.body || {};

        let cleanPhone = null;
        if (usePairingCode) {
            if (!phone) {
                return res.status(400).json({ success: false, error: 'Numéro requis pour le code d\'appairage' });
            }
            cleanPhone = phone.replace(/\D/g, '');
            if (cleanPhone.length < 8) {
                return res.status(400).json({ success: false, error: 'Numéro de téléphone invalide' });
            }
        } else if (phone) {
            cleanPhone = phone.replace(/\D/g, '');
        }

        // Générer un sessionId unique
        const sessionId = crypto.randomUUID();

        // Lancer la session Baileys en arrière-plan
        sessionManager.createSession(sessionId, cleanPhone, !!usePairingCode);

        // Attendre brièvement si le QR code est généré immédiatement
        if (!usePairingCode) {
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 250));
                const qr = sessionManager.getQR(sessionId);
                if (qr) {
                    return res.json({ success: true, sessionId, qr });
                }
            }
        }

        return res.json({ success: true, sessionId });

    } catch (error) {
        console.error('Erreur /connect:', error);
        return res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

// GET /api/qr/:sessionId — Récupérer le QR code actuel de la session
router.get('/qr/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session non trouvée' });
    }
    return res.json({
        success: true,
        sessionId,
        status: session.status,
        qr: session.lastQR,
        code: session.lastPairingCode
    });
});

// GET /api/status/:sessionId — Vérifier le statut d'une session
router.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = sessionManager.getStatus(sessionId);
    return res.json({ sessionId, status });
});

// GET /api/session/active — Vérifier s'il y a déjà une session active/connectée
router.get('/session/active', (req, res) => {
    const active = sessionManager.getActiveSession();
    return res.json({
        success: true,
        hasActiveSession: !!active,
        session: active || null
    });
});

// POST /api/session/delete — Supprimer définitivement une session (ou toutes) pour en refaire une nouvelle
router.post('/session/delete', async (req, res) => {
    try {
        const { sessionId } = req.body || {};
        if (sessionId) {
            await sessionManager.deleteSession(sessionId);
        } else {
            await sessionManager.deleteAllSessions();
        }
        return res.json({ success: true, message: 'Session supprimée avec succès' });
    } catch (err) {
        console.error('Erreur suppression session:', err);
        return res.status(500).json({ success: false, error: 'Erreur lors de la suppression' });
    }
});

// POST /api/disconnect — Déconnecter une session
router.post('/disconnect', async (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) {
        await sessionManager.deleteSession(sessionId);
    } else {
        await sessionManager.deleteAllSessions();
    }
    return res.json({ success: true, message: 'Session supprimée' });
});

module.exports = { router, setSessionManager };
