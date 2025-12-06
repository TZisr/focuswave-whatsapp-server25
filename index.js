const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ============ STATE ============
let qrCode = null;
let connectionStatus = 'initializing';
let userInfo = null;

// ============ WHATSAPP CLIENT ============
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// ============ EVENT HANDLERS ============

client.on('qr', async (qr) => {
  console.log('📲 QR Code received!');
  connectionStatus = 'waiting_for_scan';
  
  // Show in terminal
  qrcodeTerminal.generate(qr, { small: true });
  
  // Generate data URL for API
  try {
    qrCode = await QRCode.toDataURL(qr);
    console.log('✅ QR Code ready for scanning');
  } catch (err) {
    console.error('QR generation error:', err.message);
  }
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading: ${percent}% - ${message}`);
  connectionStatus = 'loading';
});

client.on('authenticated', () => {
  console.log('🔐 Authenticated!');
  connectionStatus = 'authenticated';
  qrCode = null;
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
  connectionStatus = 'auth_failed';
  qrCode = null;
});

client.on('ready', () => {
  console.log('✅ WhatsApp client is ready!');
  connectionStatus = 'connected';
  qrCode = null;
  
  const info = client.info;
  userInfo = {
    name: info.pushname || 'Unknown',
    id: info.wid?.user || 'Unknown',
    platform: info.platform || 'Unknown'
  };
  console.log(`👤 Logged in as: ${userInfo.name} (${userInfo.id})`);
});

client.on('disconnected', (reason) => {
  console.log('🔌 Disconnected:', reason);
  connectionStatus = 'disconnected';
  qrCode = null;
  userInfo = null;
  
  // Attempt to reconnect
  console.log('🔄 Attempting to reconnect...');
  setTimeout(() => {
    client.initialize();
  }, 5000);
});

// ============ API ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    connected: connectionStatus === 'connected',
    uptime: Math.floor(process.uptime())
  });
});

// Connection status
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    hasQR: qrCode !== null,
    user: userInfo
  });
});

// Get QR code
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ 
      status: 'connected',
      message: 'Already connected to WhatsApp',
      qr: null 
    });
  }

  if (!qrCode) {
    return res.status(202).json({ 
      status: connectionStatus,
      message: 'QR code not ready yet, please wait...',
      qr: null 
    });
  }

  res.json({ 
    status: 'waiting_for_scan',
    qr: qrCode 
  });
});

// Get all chats
app.get('/chats', async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ 
      error: 'Not connected',
      status: connectionStatus 
    });
  }

  try {
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage?.body?.substring(0, 100) || null
    }));

    res.json({ 
      count: chatList.length,
      chats: chatList 
    });
  } catch (err) {
    console.error('Error fetching chats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get messages from a specific chat
app.get('/messages/:chatId', async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  try {
    const chatId = req.params.chatId;
    const limit = parseInt(req.query.limit) || 50;
    
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    
    const messageList = messages.map(msg => ({
      id: msg.id._serialized,
      body: msg.body,
      from: msg.from,
      to: msg.to,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      type: msg.type,
      author: msg.author || null
    }));

    res.json({ 
      chatId,
      count: messageList.length,
      messages: messageList 
    });
  } catch (err) {
    console.error('Error fetching messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get contact info
app.get('/contact/:contactId', async (req, res) => {
  if (connectionStatus !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  try {
    const contact = await client.getContactById(req.params.contactId);
    res.json({
      id: contact.id._serialized,
      name: contact.name || contact.pushname || 'Unknown',
      number: contact.number,
      isGroup: contact.isGroup,
      isMe: contact.isMe
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect / Logout
app.post('/disconnect', async (req, res) => {
  try {
    await client.logout();
    connectionStatus = 'disconnected';
    qrCode = null;
    userInfo = null;
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force restart
app.post('/restart', async (req, res) => {
  console.log('🔄 Manual restart requested');
  connectionStatus = 'initializing';
  qrCode = null;
  userInfo = null;
  
  try {
    await client.destroy();
  } catch (e) {
    console.log('Client destroy error (ignored):', e.message);
  }
  
  setTimeout(() => {
    client.initialize();
  }, 1000);
  
  res.json({ success: true, message: 'Restarting connection...' });
});

// ============ START SERVER ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║     FocusWave WhatsApp Server         ║');
  console.log('║     (whatsapp-web.js / Chromium)      ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log('');
  
  // Start WhatsApp client
  console.log('🚀 Initializing WhatsApp client...');
  client.initialize();
});
