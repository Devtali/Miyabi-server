require('dotenv').config();

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionManager = new SessionManager(io);
setSessionManager(sessionManager);

setInterval(() => sessionManager.cleanupStaleSessions(), 300000);

app.use('/api', apiRouter);

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

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎀 Miyabi Server démarré sur le port ${PORT}`);
    console.log(`🌐 Interface: http://0.0.0.0:${PORT}`);
    console.log(`📡 API: http://0.0.0.0:${PORT}/api\n`);
});
