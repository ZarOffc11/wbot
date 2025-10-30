const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let sock = null;
let pairingCode = null;

// Function to initialize WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Nonaktifkan QR terminal
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR Code received:', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('Connection closed, reconnecting...');
                connectToWhatsApp();
            } else {
                console.log('Connection closed, please login again.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected successfully!');
            pairingCode = null; // Reset pairing code setelah terhubung
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    return sock;
}

// API untuk request pairing code
app.post('/request-pairing', async (req, res) => {
    try {
        if (!sock) {
            await connectToWhatsApp();
        }
        
        // Request pairing code
        pairingCode = await sock.requestPairingCode(req.body.phoneNumber);
        
        res.json({ 
            success: true, 
            pairingCode,
            message: 'Pairing code generated successfully'
        });
    } catch (error) {
        console.error('Error generating pairing code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate pairing code' 
        });
    }
});

// API untuk check connection status
app.get('/status', (req, res) => {
    if (sock && sock.user) {
        res.json({ 
            connected: true, 
            user: sock.user 
        });
    } else {
        res.json({ 
            connected: false, 
            pairingCode 
        });
    }
});

// Handle messages
sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    
    if (!message.key.fromMe && m.type === 'notify') {
        console.log('Received message:', message);
        
        // Auto reply example
        await sock.sendMessage(message.key.remoteJid, { 
            text: 'Hello! This is an auto-reply from your WhatsApp bot.' 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});