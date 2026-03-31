const OpenAI = require('openai');
const { supabase } = require('../config/supabase');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Monthly quota per plan
const PLAN_QUOTAS = {
  beta:     100,
  pro:      1000,
  pro_plus: 5000
};

// GPT-4o Mini pricing (per 1K tokens, USD)
const COST_PER_1K_INPUT  = 0.00015;
const COST_PER_1K_OUTPUT = 0.00060;

// ─── Quota ────────────────────────────────────────────────────────────────────

/**
 * Returns how many AI calls this org has used in the current calendar month.
 */
async function getMonthlyUsage(orgId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('ai_calls')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .gte('created_at', startOfMonth.toISOString());

  return count || 0;
}

/**
 * Checks quota and throws a Hebrew error if exceeded.
 * Returns { used, limit, plan } on success.
 */
async function enforceQuota(orgId) {
  const { data: org, error } = await supabase
    .from('organizations')
    .select('plan, ai_calls_limit')
    .eq('id', orgId)
    .single();

  if (error || !org) throw new Error('ארגון לא נמצא');

  const plan = org.plan || 'beta';
  const limit = org.ai_calls_limit ?? PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.beta;
  const used  = await getMonthlyUsage(orgId);

  if (used >= limit) {
    const planNames = { beta: 'בטא', pro: 'Pro', pro_plus: 'Pro+' };
    throw Object.assign(
      new Error(
        `הגעת למכסת ה-AI החודשית שלך (${used}/${limit} שיחות בחבילת ${planNames[plan] || plan}). ` +
        `לשדרוג חבילה, פנה אלינו בהגדרות.`
      ),
      { status: 429, code: 'QUOTA_EXCEEDED', used, limit, plan }
    );
  }

  return { used, limit, plan };
}

/**
 * Logs an AI call and increments the monthly counter.
 */
async function logCall(orgId, userId, type, inputTokens, outputTokens) {
  const tokens  = (inputTokens || 0) + (outputTokens || 0);
  const costUsd = ((inputTokens  || 0) / 1000 * COST_PER_1K_INPUT) +
                  ((outputTokens || 0) / 1000 * COST_PER_1K_OUTPUT);

  await supabase.from('ai_calls').insert({
    organization_id: orgId,
    user_id: userId,
    type,
    tokens_used: tokens,
    cost_usd: costUsd
  });
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `אתה מזכירה AI של Flow – פלטפורמת ניהול עסק חכמה לעסקים קטנים ובינוניים בישראל.
אתה עוזר לצוות לנהל לקוחות, לידים, ושיחות בצורה יעילה.
עונה תמיד בעברית, אלא אם המשתמש כתב באנגלית.
תשובות קצרות, ממוקדות ומקצועיות.
אל תמציא מידע – אם אינך יודע, אמור זאת בכנות.`;

// ─── AI functions ─────────────────────────────────────────────────────────────

/**
 * Free chat with the AI secretary.
 * messages: [{ role: 'user'|'assistant', content: string }]
 */
async function chat(orgId, userId, messages) {
  await enforceQuota(orgId);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    max_tokens: 1024,
    temperature: 0.7
  });

  const reply  = response.choices[0].message.content;
  const usage  = response.usage;

  await logCall(orgId, userId, 'chat', usage.prompt_tokens, usage.completion_tokens);

  return { reply, tokens_used: usage.total_tokens };
}

/**
 * Suggest a reply to an incoming message.
 * Receives the last N messages from the conversation as context.
 */
async function suggestReply(orgId, userId, { contactName, channelType, messages }) {
  await enforceQuota(orgId);

  const history = messages
    .slice(-10) // last 10 messages for context
    .map(m => `${m.direction === 'in' ? contactName : 'אנחנו'}: ${m.content}`)
    .join('\n');

  const prompt = `הלקוח ${contactName} פנה אלינו דרך ${channelType}.
היסטוריית שיחה:
${history}

הצע תשובה מקצועית וחמה בשם העסק. תשובה קצרה ורלוונטית בלבד.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: prompt }
    ],
    max_tokens: 300,
    temperature: 0.6
  });

  const suggestion = response.choices[0].message.content;
  const usage      = response.usage;

  await logCall(orgId, userId, 'suggest_reply', usage.prompt_tokens, usage.completion_tokens);

  return { suggestion, tokens_used: usage.total_tokens };
}

/**
 * Transcribe an audio message using Whisper.
 * audioBuffer: Buffer of the audio file
 * mimeType: e.g. 'audio/ogg', 'audio/mp4'
 */
async function transcribe(orgId, userId, audioBuffer, mimeType) {
  await enforceQuota(orgId);

  // Whisper requires a File-like object
  const ext = mimeType?.split('/')[1]?.split(';')[0] || 'ogg';
  const file = new File([audioBuffer], `audio.${ext}`, { type: mimeType || 'audio/ogg' });

  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language: 'he'  // Hebrew-first, fallback to auto-detect
  });

  // Whisper is billed per second, not tokens — log as 1 call with 0 tokens
  await logCall(orgId, userId, 'transcribe', 0, 0);

  return { text: response.text };
}

/**
 * Bot auto-reply for incoming customer messages.
 * Used when bot_enabled = true on the organization.
 */
async function botReply(orgId, { contactName, channelType, messages, businessContext }) {
  await enforceQuota(orgId);

  const history = messages
    .slice(-6)
    .map(m => `${m.direction === 'in' ? contactName : 'העסק'}: ${m.content}`)
    .join('\n');

  const systemPrompt = businessContext
    ? `${SYSTEM_PROMPT}\n\nמידע על העסק: ${businessContext}`
    : SYSTEM_PROMPT;

  const prompt = `לקוח בשם ${contactName} פנה דרך ${channelType}.
היסטוריית שיחה:
${history}

כתוב תשובה אוטומטית קצרה, מקצועית וחמה. אל תחרוג מ-3 משפטים.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt }
    ],
    max_tokens: 200,
    temperature: 0.5
  });

  const reply = response.choices[0].message.content;
  const usage = response.usage;

  // Bot calls are attributed to org (no specific user)
  await logCall(orgId, null, 'bot', usage.prompt_tokens, usage.completion_tokens);

  return { reply, tokens_used: usage.total_tokens };
}

module.exports = { chat, suggestReply, transcribe, botReply, enforceQuota, getMonthlyUsage };
