const crypto = require('crypto');

// Clé admin : ADMIN_KEY dans .env. Si absente, une clé aléatoire est générée
// au démarrage et affichée dans la console (l'API n'est JAMAIS ouverte).
let ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
let generated = false;
if (!ADMIN_KEY) {
    ADMIN_KEY = crypto.randomBytes(16).toString('hex');
    generated = true;
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

const isValidKey = (key) => safeEqual(key, ADMIN_KEY);

// Middleware Express (en-tête x-admin-key)
function requireAdmin(req, res, next) {
    if (isValidKey(req.get('x-admin-key'))) return next();
    return res.status(401).json({ success: false, error: 'Non autorisé (clé admin invalide)' });
}

// Middleware Socket.io (handshake.auth.key)
function socketAuth(socket, next) {
    if (isValidKey(socket.handshake?.auth?.key)) return next();
    return next(new Error('unauthorized'));
}

// Limiteur simple en mémoire (par IP) pour les routes sensibles
function rateLimit({ windowMs = 60000, max = 5 } = {}) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [ip, arr] of hits) {
            const recent = arr.filter(t => now - t < windowMs);
            if (recent.length) hits.set(ip, recent); else hits.delete(ip);
        }
    }, windowMs).unref();
    return (req, res, next) => {
        const now = Date.now();
        const arr = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
        if (arr.length >= max) {
            return res.status(429).json({ success: false, error: 'Trop de requêtes, réessaie dans une minute' });
        }
        arr.push(now);
        hits.set(req.ip, arr);
        next();
    };
}

module.exports = { requireAdmin, socketAuth, rateLimit, ADMIN_KEY, keyWasGenerated: generated };
