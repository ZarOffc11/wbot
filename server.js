const express = require('express');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = 3000;

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
    try {
        const { useMultiFileAuthState, makeWASocket, DisconnectReason, Browsers } = await loadBaileys();
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome')
        });

        // Event listener untuk connection update
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
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
                pairingCode = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Event listener untuk messages
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            
            if (!message.key.fromMe && m.type === 'notify') {
                console.log('📨 Received message from:', message.key.remoteJid);
                console.log('Message content:', message.message);
            }
        });

        console.log('✅ WhatsApp client initialized');
        return sock;
        
    } catch (error) {
        console.error('❌ Error initializing WhatsApp:', error);
        return null;
    }
}

// API untuk request pairing code
app.post('/request-pairing', async (req, res) => {
    try {
        if (!sock) {
            await connectToWhatsApp();
        }
        
        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }
        
        pairingCode = await sock.requestPairingCode(phoneNumber);
        
        res.json({ 
            success: true, 
            pairingCode,
            message: 'Pairing code generated successfully'
        });
    } catch (error) {
        console.error('Error generating pairing code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate pairing code: ' + error.message 
        });
    }
});

// API untuk check connection status
app.get('/status', (req, res) => {
    if (sock && sock.user) {
        res.json({ 
            connected: true, 
            user: {
                id: sock.user.id,
                name: sock.user.name
            }
        });
    } else {
        res.json({ 
            connected: false, 
            pairingCode 
        });
    }
});

// Send message via POST (existing)
app.post('/send-message', async (req, res) => {
    try {
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp not connected'
            });
        }

        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({
                success: false,
                message: 'Number and message are required'
            });
        }

        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        await sock.sendMessage(chatId, { text: message });
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message: ' + error.message
        });
    }
});

// ✅ NEW: Send test message via GET dengan query parameters
app.get('/send-test', async (req, res) => {
    try {
        const { number, text } = req.query;
        
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp not connected. Please pair first.'
            });
        }

        if (!number || !text) {
            return res.status(400).json({
                success: false,
                message: 'Parameters "number" and "text" are required'
            });
        }

        // Format nomor (tambah @c.us jika belum ada)
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        
        console.log(`📤 Sending test message to: ${chatId}`);
        console.log(`💬 Message: ${text}`);
        
        await sock.sendMessage(chatId, { text: text });
        
        res.json({
            success: true,
            message: 'Test message sent successfully',
            data: {
                to: chatId,
                text: text,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Error sending test message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send test message: ' + error.message
        });
    }
});

// ✅ NEW: Simple test message dengan default text
app.get('/send-hello', async (req, res) => {
    try {
        const { number } = req.query;
        
        if (!sock) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp not connected'
            });
        }

        if (!number) {
            return res.status(400).json({
                success: false,
                message: 'Parameter "number" is required'
            });
        }

        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        const testMessage = 'Hello! This is a test message from your WhatsApp bot. 🚀';
        
        await sock.sendMessage(chatId, {
    interactiveMessage: {
        header: "Hello World",
        title: "Hello World",
        footer: "telegram: @ZarOffc ",
        buttons: [
            {
                name: "cta_copy",
                buttonParamsJson: JSON.stringify({
                    display_text: "copy code",
                    id: "123456789",              
                    copy_code: "ABC123XYZ"
                })
            }
        ]
    }
}, { quoted: m });
        
        res.json({
            success: true,
            message: 'Hello message sent successfully',
            data: {
                to: chatId,
                text: testMessage
            }
        });
        
    } catch (error) {
        console.error('Error sending hello message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send hello message: ' + error.message
        });
    }
});

// Initialize WhatsApp connection
async function initializeApp() {
    try {
        await connectToWhatsApp();
        console.log('🚀 WhatsApp bot initialized');
    } catch (error) {
        console.error('❌ Failed to initialize WhatsApp:', error);
    }
}

app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log(`📤 Test endpoints:`);
    console.log(`   GET /send-test?number=628123456789&text=HelloWorld`);
    console.log(`   GET /send-hello?number=628123456789`);
    initializeApp();
});
