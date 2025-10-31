const express = require('express');
const { Boom } = require('@hapi/boom');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let sock = null;
let pairingCode = null;
let baileys = null;

// Load Baileys dengan dynamic import
async function loadBaileys() {
    if (!baileys) {
        baileys = await import('@whiskeysockets/baileys');
    }
    return baileys;
}

async function connectToWhatsApp() {
    const { useMultiFileAuthState, makeWASocket, DisconnectReason, Browsers } = await loadBaileys();
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                console.log('Connection closed, reconnecting...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected successfully!');
            pairingCode = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    return sock;
}

app.post('/request-pairing', async (req, res) => {
    try {
        if (!sock) {
            await connectToWhatsApp();
        }
        
        const phoneNumber = req.body.phoneNumber;
        pairingCode = await sock.requestPairingCode(phoneNumber);
        
        res.json({ 
            success: true, 
            pairingCode,
            message: 'Pairing code generated successfully'
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate pairing code' 
        });
    }
});

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

app.get('/send-message1', (req, res) => {
    if (!sock) {
        res.status(400).json({
            status: "Not Connected to WhatsApp!"
        }) 
    }
    try {
    await sock.sendMessage("6289670470227@s.whatsapp.net", { text: "Tes 1 Berhasil!" }, { quotes: null })
    res.json({
        status: 200,
        message: "Tes Berhasil Dikirim!"
    })
    } catch (err) {
        res.status(500).json({
            message: "Tes Gagal!", 
            error: err
        }) 
    }
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectToWhatsApp();
});
