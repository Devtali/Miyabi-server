require('dotenv').config({ override: true });

// Filtrer les messages de bruit de libsignal (Bad MAC et renégociation de sessions Signal)
const origConsoleError = console.error;
console.error = function (...args) {
    const text = args.map(a => (a && a.stack ? a.stack : String(a))).join(' ');
    if (text.includes('Failed to decrypt message with any known session') || text.includes('Bad MAC')) {
        return;
    }
    origConsoleError.apply(console, args);
};

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const SessionManager = require('./src/core/sessionManager');
const { router: apiRouter, setSessionManager } = require('./src/routes/api');
const { requireAdmin, socketAuth, ADMIN_KEY, keyWasGenerated } = require('./src/middleware/auth');

const app = express();
const server = http.createServer(app);
// CORS : même origine par défaut. Pour autoriser un autre site : CORS_ORIGIN=https://mon-site.com
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false;
const io = new Server(server, {
    cors: corsOrigin ? { origin: corsOrigin, methods: ['GET', 'POST'] } : undefined
});
io.use(socketAuth);

app.set('trust proxy', 1);
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionManager = new SessionManager(io);
setSessionManager(sessionManager);

setInterval(() => sessionManager.cleanupStaleSessions(), 300000);

app.use('/api', requireAdmin, apiRouter);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`🔌 Client connecté: ${socket.id}`);
    socket.on('join_session', (sessionId) => {
        socket.join(sessionId);
        console.log(`📡 Client ${socket.id} rejoint session: ${sessionId}`);
        const session = sessionManager.getSession(sessionId);
        if (session) {
            if (session.lastQR) {
                console.log(`📡 Envoi immédiat du QR existant à ${socket.id}`);
                socket.emit('qr', { qr: session.lastQR });
            }
            if (session.lastPairingCode) {
                socket.emit('pairing_code', { code: session.lastPairingCode });
            }
            socket.emit('status_update', { status: session.status });
        }
    });
    socket.on('disconnect', () => {
        console.log(`🔌 Client déconnecté: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎀 Miyabi Server démarré sur le port ${PORT}`);
    console.log(`🌐 Interface: http://0.0.0.0:${PORT}`);
    console.log(`📡 API: http://0.0.0.0:${PORT}/api\n`);
    if (keyWasGenerated) {
        console.log(`🔑 ADMIN_KEY non définie dans .env — clé temporaire générée : ${ADMIN_KEY}`);
        console.log('   (définis ADMIN_KEY dans .env pour la garder entre les redémarrages)\n');
    } else {
        console.log('🔑 Interface protégée par ADMIN_KEY\n');
    }
});
