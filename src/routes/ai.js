const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const ai = require('../services/ai');

router.use(authenticateUser);

// multer: audio in memory (max 25MB — Whisper limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ─── Error handler for quota / OpenAI errors ──────────────────────────────────
function handleAiError(err, res) {
  if (err.code === 'QUOTA_EXCEEDED') {
    return res.status(429).json({ error: err.message, used: err.used, limit: err.limit, plan: err.plan });
  }
  if (err.status === 401) {
    return res.status(500).json({ error: 'מפתח OpenAI לא תקין. בדוק את ההגדרות.' });
  }
  console.error('AI error:', err.message);
  res.status(500).json({ error: 'שגיאה בשירות ה-AI. נסה שוב.' });
}

// ─── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages הוא שדה חובה (מערך)' });
    }

    const result = await ai.chat(req.user.organization_id, req.user.id, messages);
    res.json(result);
  } catch (err) {
    handleAiError(err, res);
  }
});

// ─── POST /api/ai/suggest-reply ───────────────────────────────────────────────
router.post('/suggest-reply', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id הוא שדה חובה' });
    }

    // Fetch conversation + contact info
    const { data: conv } = await supabase
      .from('conversations')
      .select('id, channel_type, contact:contacts(name)')
      .eq('id', conversation_id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!conv) return res.status(404).json({ error: 'שיחה לא נמצאה' });

    // Fetch last 10 messages
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, content, type')
      .eq('conversation_id', conversation_id)
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!messages?.length) {
      return res.status(400).json({ error: 'אין הודעות בשיחה זו' });
    }

    const result = await ai.suggestReply(req.user.organization_id, req.user.id, {
      contactName: conv.contact?.name || 'לקוח',
      channelType: conv.channel_type || 'whatsapp',
      messages: messages.reverse()
    });

    res.json(result);
  } catch (err) {
    handleAiError(err, res);
  }
});

// ─── POST /api/ai/transcribe ──────────────────────────────────────────────────
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'יש לשלוח קובץ audio' });
    }

    const result = await ai.transcribe(
      req.user.organization_id,
      req.user.id,
      req.file.buffer,
      req.file.mimetype
    );

    res.json(result);
  } catch (err) {
    handleAiError(err, res);
  }
});

// ─── POST /api/ai/bot-reply ───────────────────────────────────────────────────
router.post('/bot-reply', async (req, res) => {
  try {
    const { conversation_id, business_context } = req.body;
    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id הוא שדה חובה' });
    }

    // Verify bot is enabled for this org
    const { data: org } = await supabase
      .from('organizations')
      .select('bot_enabled')
      .eq('id', req.user.organization_id)
      .single();

    if (!org?.bot_enabled) {
      return res.status(403).json({ error: 'הבוט אינו מופעל עבור הארגון שלך' });
    }

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, channel_type, contact:contacts(name)')
      .eq('id', conversation_id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!conv) return res.status(404).json({ error: 'שיחה לא נמצאה' });

    const { data: messages } = await supabase
      .from('messages')
      .select('direction, content')
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: false })
      .limit(6);

    const result = await ai.botReply(req.user.organization_id, {
      contactName: conv.contact?.name || 'לקוח',
      channelType: conv.channel_type,
      messages: (messages || []).reverse(),
      businessContext: business_context
    });

    res.json(result);
  } catch (err) {
    handleAiError(err, res);
  }
});

// ─── GET /api/ai/usage ────────────────────────────────────────────────────────
router.get('/usage', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Total calls this month
    const used = await ai.getMonthlyUsage(orgId);

    // Org plan + limit
    const { data: org } = await supabase
      .from('organizations')
      .select('plan, ai_calls_limit')
      .eq('id', orgId)
      .single();

    const PLAN_QUOTAS = { beta: 100, pro: 1000, pro_plus: 5000 };
    const plan  = org?.plan || 'beta';
    const limit = org?.ai_calls_limit ?? PLAN_QUOTAS[plan] ?? 100;

    // Breakdown by type this month
    const { data: breakdown } = await supabase
      .from('ai_calls')
      .select('type, tokens_used, cost_usd')
      .eq('organization_id', orgId)
      .gte('created_at', startOfMonth.toISOString());

    const byType = {};
    let totalTokens = 0;
    let totalCost   = 0;

    for (const call of breakdown || []) {
      if (!byType[call.type]) byType[call.type] = { calls: 0, tokens: 0, cost_usd: 0 };
      byType[call.type].calls++;
      byType[call.type].tokens    += call.tokens_used || 0;
      byType[call.type].cost_usd  += parseFloat(call.cost_usd || 0);
      totalTokens += call.tokens_used || 0;
      totalCost   += parseFloat(call.cost_usd || 0);
    }

    res.json({
      plan,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      percent_used: Math.round((used / limit) * 100),
      total_tokens: totalTokens,
      total_cost_usd: parseFloat(totalCost.toFixed(4)),
      breakdown: byType,
      reset_date: new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 1).toISOString()
    });
  } catch (err) {
    console.error('AI usage error:', err);
    res.status(500).json({ error: 'Failed to get AI usage' });
  }
});

module.exports = router;
