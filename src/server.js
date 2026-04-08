require('dotenv').config();

// ─── Startup environment validation ──────────────────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const WARN_ENV = ['SUPABASE_ANON_KEY', 'OPENAI_API_KEY', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
}
for (const key of WARN_ENV) {
  if (!process.env[key]) {
    console.warn(`WARNING: Missing env var: ${key} — some features will be disabled`);
  }
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { supabase } = require('./config/supabase');

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Rate limiting: 100 requests per 15 minutes
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
}));

// Routes
const authRoutes = require('./routes/auth');
const contactsRoutes = require('./routes/contacts');
const conversationsRoutes = require('./routes/conversations');
const channelsRoutes = require('./routes/channels');
const tasksRoutes = require('./routes/tasks');
const documentsRoutes = require('./routes/documents');
const eventsRoutes = require('./routes/events');
const aiRoutes = require('./routes/ai');
const googleRoutes = require('./routes/google');
const notificationsRoutes = require('./routes/notifications');
const orgRoutes = require('./routes/org');
const statsRoutes = require('./routes/stats');
const webhooksRoutes = require('./routes/webhooks');

app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/channels/google', googleRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/stats', statsRoutes);
app.use('/webhooks', webhooksRoutes);

// Realtime config — tells the frontend which channel to subscribe to
// and provides the public (anon) key for the Supabase Realtime connection
app.get('/api/realtime/config', require('./middleware/auth').authenticateUser, (req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY,
    channel: `org:${req.user.organization_id}`,
    events: ['new_message', 'conversation_assigned', 'new_task', 'document_updated', 'event_reminder', 'chat_import_progress']
  });
});

// Health check with Supabase connection verification
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let tableCount = 0;

  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('id', { count: 'exact', head: true });

    if (!error) {
      dbStatus = 'connected';
    }
  } catch (err) {
    dbStatus = 'error';
  }

  res.json({
    status: 'ok',
    service: 'flow-backend',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// WhatsApp/Chromium diagnostic — check if Puppeteer can launch
app.get('/health/whatsapp', async (req, res) => {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  try {
    // Use puppeteer bundled with whatsapp-web.js
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    });
    const version = await browser.version();
    await browser.close();
    res.json({ status: 'ok', chromium: version, executablePath: execPath });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message, executablePath: execPath });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Flow Backend running on port ${PORT}`);
  // Start reminder scheduler
  require('./services/reminderScheduler').start();
});

module.exports = app;
