const express = require('express');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// Store active connections per number
const activeConnections = new Map();
let baileys = null;

// Load Baileys dengan dynamic import
async function loadBaileys() {
    if (!baileys) {
        baileys = await import('@whiskeysockets/baileys');
    }
    return baileys;
}

// Function untuk delete session folder
function deleteSessionFolder(phoneNumber) {
    try {
        const sanitizedNumber = phoneNumber.replace(/[^0-9]/g, '');
        const sessionFolder = path.join(__dirname, 'sessions', `${sanitizedNumber}-sesi`);
        
        if (fs.existsSync(sessionFolder)) {
            // Hapus semua file dalam folder
            const files = fs.readdirSync(sessionFolder);
            for (const file of files) {
                fs.unlinkSync(path.join(sessionFolder, file));
            }
            // Hapus folder itu sendiri
            fs.rmdirSync(sessionFolder);
            
            console.log(`🗑️ Deleted session folder for: ${phoneNumber}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`❌ Error deleting session folder for ${phoneNumber}:`, error);
        return false;
    }
}

// Function untuk cleanup connection
function cleanupConnection(phoneNumber) {
    // Hapus dari active connections
    activeConnections.delete(phoneNumber);
    console.log(`🔒 Removed ${phoneNumber} from active connections`);
    
    // Hapus session folder
    deleteSessionFolder(phoneNumber);
}

// Custom auth state untuk per nomor
async function useMultiFileAuthStateByNumber(phoneNumber) {
    const { useMultiFileAuthState } = await loadBaileys();
    
    // Sanitize phone number untuk nama folder
    const sanitizedNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFolder = path.join(__dirname, 'sessions', `${sanitizedNumber}-sesi`);
    
    // Pastikan folder sessions exists
    if (!fs.existsSync(path.join(__dirname, 'sessions'))) {
        fs.mkdirSync(path.join(__dirname, 'sessions'));
    }
    
    console.log(`📁 Using session folder: ${sessionFolder}`);
    return useMultiFileAuthState(sessionFolder);
}

// Function untuk connect WhatsApp per nomor
async function connectToWhatsApp(phoneNumber) {
    try {
        console.log(`🔗 Connecting WhatsApp for: ${phoneNumber}`);
        
        const { makeWASocket, DisconnectReason, Browsers } = await loadBaileys();
        const { state, saveCreds } = await useMultiFileAuthStateByNumber(phoneNumber);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome')
        });

        // Event listener untuk connection update
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                console.log(`🔌 Connection closed for ${phoneNumber}, reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    // Auto reconnect setelah 5 detik
                    setTimeout(() => connectToWhatsApp(phoneNumber), 5000);
                } else {
                    // LOGOUT / DISCONNECT - HAPUS SESSION
                    console.log(`🚫 Logged out/disconnected for ${phoneNumber}, cleaning up...`);
                    cleanupConnection(phoneNumber);
                }
            } else if (connection === 'open') {
                console.log(`✅ WhatsApp connected successfully for: ${phoneNumber}`);
                
                // Simpan connection ke map
                activeConnections.set(phoneNumber, {
                    sock: sock,
                    user: sock.user,
                    connectedAt: new Date()
                });
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Event listener untuk messages
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            
            if (!message.key.fromMe && m.type === 'notify') {
                console.log(`📨 ${phoneNumber} received message from:`, message.key.remoteJid);
            }
        });

        console.log(`✅ WhatsApp client initialized for: ${phoneNumber}`);
        return sock;
        
    } catch (error) {
        console.error(`❌ Error initializing WhatsApp for ${phoneNumber}:`, error);
        return null;
    }
}

// API untuk request pairing code - FIXED
app.post('/request-pairing', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // Cek apakah sudah ada connection aktif untuk nomor ini
        if (activeConnections.has(phoneNumber)) {
            const existingConn = activeConnections.get(phoneNumber);
            if (existingConn.sock.user) {
                return res.json({
                    success: true,
                    alreadyConnected: true,
                    message: 'WhatsApp already connected for this number',
                    user: existingConn.sock.user
                });
            }
        }

        console.log(`🔄 Initializing WhatsApp for: ${phoneNumber}`);
        const sock = await connectToWhatsApp(phoneNumber);
        
        if (!sock) {
            return res.status(500).json({
                success: false,
                message: 'Failed to initialize WhatsApp connection'
            });
        }

        // ⚠️ TAMBAHKAN DELAY - tunggu connection siap
        console.log(`⏳ Waiting for connection to be ready...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Cek lagi apakah sock masih ada dan ready
        if (!sock || sock.connection === 'close') {
            return res.status(500).json({
                success: false,
                message: 'Connection failed during initialization'
            });
        }

        // Generate pairing code
        console.log(`📞 Requesting pairing code for: ${phoneNumber}`);
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        
        console.log(`✅ Pairing code generated: ${pairingCode} for ${phoneNumber}`);
        
        res.json({ 
            success: true, 
            pairingCode,
            phoneNumber,
            message: 'Pairing code generated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error generating pairing code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate pairing code: ' + error.message 
        });
    }
});

// API untuk check connection status (per nomor)
app.get('/status', (req, res) => {
    const { number } = req.query;
    
    if (number && activeConnections.has(number)) {
        const conn = activeConnections.get(number);
        res.json({ 
            connected: true,
            phoneNumber: number,
            user: {
                id: conn.user.id,
                name: conn.user.name
            },
            connectedAt: conn.connectedAt
        });
    } else {
        res.json({ 
            connected: false,
            phoneNumber: number || null,
            activeConnections: Array.from(activeConnections.keys())
        });
    }
});

// API untuk list semua active connections
app.get('/active-connections', (req, res) => {
    const connections = Array.from(activeConnections.entries()).map(([number, data]) => ({
        phoneNumber: number,
        connected: true,
        user: data.user,
        connectedAt: data.connectedAt
    }));
    
    res.json({
        total: connections.length,
        connections: connections
    });
});

// Send message via POST (per nomor)
app.post('/send-message', async (req, res) => {
    try {
        const { fromNumber, toNumber, message } = req.body;

        if (!fromNumber || !toNumber || !message) {
            return res.status(400).json({
                success: false,
                message: 'fromNumber, toNumber, and message are required'
            });
        }

        if (!activeConnections.has(fromNumber)) {
            return res.status(400).json({
                success: false,
                message: `No active WhatsApp connection for ${fromNumber}`
            });
        }

        const conn = activeConnections.get(fromNumber);
        const chatId = toNumber.includes('@c.us') ? toNumber : `${toNumber}@c.us`;
        
        await conn.sock.sendMessage(chatId, { text: message });
        
        res.json({
            success: true,
            message: 'Message sent successfully',
            from: fromNumber,
            to: toNumber
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message: ' + error.message
        });
    }
});

// ✅ Send test message via GET (per nomor)
app.get('/send-test', async (req, res) => {
    try {
        const { from, to, text } = req.query;
        
        if (!from || !to || !text) {
            return res.status(400).json({
                success: false,
                message: 'Parameters "from", "to", and "text" are required'
            });
        }

        if (!activeConnections.has(from)) {
            return res.status(400).json({
                success: false,
                message: `No active WhatsApp connection for ${from}. Please pair first.`
            });
        }

        const conn = activeConnections.get(from);
        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        
        console.log(`📤 ${from} sending message to: ${chatId}`);
        console.log(`💬 Message: ${text}`);
        
        await conn.sock.sendMessage(chatId, { text: text });
        
        res.json({
            success: true,
            message: 'Test message sent successfully',
            data: {
                from: from,
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

// ✅ Send hello message via GET
app.get('/send-hello', async (req, res) => {
    try {
        const { from, to } = req.query;
        
        if (!from || !to) {
            return res.status(400).json({
                success: false,
                message: 'Parameters "from" and "to" are required'
            });
        }

        if (!activeConnections.has(from)) {
            return res.status(400).json({
                success: false,
                message: `No active WhatsApp connection for ${from}`
            });
        }

        const conn = activeConnections.get(from);
        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        const testMessage = `Hello from ${from}'s WhatsApp bot! 🚀`;
        
        await conn.sock.sendMessage(chatId, { text: testMessage });
        
        res.json({
            success: true,
            message: 'Hello message sent successfully',
            data: {
                from: from,
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

// API untuk disconnect specific number (MANUAL)
app.post('/disconnect', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        if (activeConnections.has(phoneNumber)) {
            const conn = activeConnections.get(phoneNumber);
            
            try {
                // Logout dari WhatsApp
                await conn.sock.logout();
                console.log(`🔒 Manual logout for: ${phoneNumber}`);
            } catch (logoutError) {
                console.log(`⚠️ Logout failed, forcing cleanup for: ${phoneNumber}`);
            }
            
            // Cleanup connection dan session folder
            cleanupConnection(phoneNumber);
            
            res.json({
                success: true,
                message: `Disconnected WhatsApp and deleted session for ${phoneNumber}`
            });
        } else {
            // Jika tidak ada di active connections, coba hapus session folder saja
            const folderDeleted = deleteSessionFolder(phoneNumber);
            
            res.json({
                success: true,
                message: `No active connection found for ${phoneNumber}` + 
                         (folderDeleted ? ', but session folder was deleted' : ', no session folder found')
            });
        }
    } catch (error) {
        console.error('Error disconnecting:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to disconnect: ' + error.message
        });
    }
});

// API untuk force cleanup tanpa logout (emergency)
app.post('/force-cleanup', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // Langsung cleanup tanpa logout
        cleanupConnection(phoneNumber);
        
        res.json({
            success: true,
            message: `Force cleanup completed for ${phoneNumber}`
        });
    } catch (error) {
        console.error('Error force cleanup:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to force cleanup: ' + error.message
        });
    }
});

// API untuk list session folders
app.get('/sessions', (req, res) => {
    try {
        const sessionsPath = path.join(__dirname, 'sessions');
        
        if (!fs.existsSync(sessionsPath)) {
            return res.json({ sessions: [] });
        }
        
        const folders = fs.readdirSync(sessionsPath)
            .filter(folder => fs.statSync(path.join(sessionsPath, folder)).isDirectory())
            .map(folder => {
                const folderPath = path.join(sessionsPath, folder);
                const files = fs.readdirSync(folderPath);
                return {
                    folder: folder,
                    files: files,
                    isActive: activeConnections.has(folder.replace('-sesi', ''))
                };
            });
        
        res.json({
            total: folders.length,
            sessions: folders
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize server
app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log(`📁 Session folders will be created in: ./sessions/`);
    console.log(`🗑️ Auto-cleanup enabled: Session folders will be deleted on disconnect/logout`);
    console.log(`🔗 Multiple WhatsApp accounts supported`);
});
