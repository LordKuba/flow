const { google } = require('googleapis');
const { supabase } = require('../config/supabase');
const { encrypt, decrypt } = require('./encryption');

// ─── OAuth2 client factory ────────────────────────────────────────────────────

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// ─── Token encryption (AES-256-GCM via encryption.js) ────────────────────────

function encryptToken(token) {
  return encrypt(token);
}

function decryptToken(encoded) {
  return decrypt(encoded);
}

// ─── Auth URL ─────────────────────────────────────────────────────────────────

function getAuthUrl(state) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',  // force refresh_token every time
    state
  });
}

// ─── Exchange code for tokens ─────────────────────────────────────────────────

async function exchangeCode(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ─── Get authenticated client for an org ─────────────────────────────────────

async function getAuthClientForOrg(orgId, channelType) {
  const { data: channel } = await supabase
    .from('channels')
    .select('access_token, refresh_token, token_expires_at')
    .eq('organization_id', orgId)
    .eq('type', channelType)
    .eq('status', 'connected')
    .single();

  if (!channel) throw new Error(`No connected ${channelType} channel for org`);

  const tokens = decryptToken(channel.access_token);
  const refresh = channel.refresh_token ? decryptToken(channel.refresh_token) : null;

  const client = createOAuthClient();
  client.setCredentials({
    access_token: tokens?.access_token || tokens,
    refresh_token: refresh?.refresh_token || refresh,
    expiry_date: tokens?.expiry_date
  });

  // Auto-refresh and persist new tokens
  client.on('tokens', async (newTokens) => {
    const updates = { access_token: encryptToken(newTokens) };
    if (newTokens.expiry_date) {
      updates.token_expires_at = new Date(newTokens.expiry_date).toISOString();
    }
    await supabase
      .from('channels')
      .update(updates)
      .eq('organization_id', orgId)
      .eq('type', channelType);
  });

  return client;
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

/**
 * Set up Gmail Push Notifications (Watch).
 * Requires a verified Pub/Sub topic. In testing mode, we use polling instead.
 */
async function setupGmailWatch(orgId) {
  const auth = await getAuthClientForOrg(orgId, 'gmail');
  const gmail = google.gmail({ version: 'v1', auth });

  // Get user info
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return { email: profile.data.emailAddress };
}

/**
 * Fetch recent unread emails from Gmail.
 */
async function fetchGmailMessages(orgId, maxResults = 10) {
  const auth = await getAuthClientForOrg(orgId, 'gmail');
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults
  });

  const messages = listRes.data.messages || [];
  const results = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date']
    });

    const headers = full.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name === name)?.value || '';

    results.push({
      id: msg.id,
      from: get('From'),
      subject: get('Subject'),
      date: get('Date'),
      snippet: full.data.snippet
    });
  }

  return results;
}

/**
 * Send an email via Gmail.
 */
async function sendGmail(orgId, { to, subject, body }) {
  const auth = await getAuthClientForOrg(orgId, 'gmail');
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

/**
 * Fetch upcoming calendar events.
 */
async function fetchCalendarEvents(orgId, { timeMin, timeMax, maxResults = 20 } = {}) {
  const auth = await getAuthClientForOrg(orgId, 'google_calendar');
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin || new Date().toISOString(),
    timeMax: timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime'
  });

  return res.data.items || [];
}

/**
 * Create a Google Calendar event.
 */
async function createCalendarEvent(orgId, { title, description, startTime, endTime, location, attendeeEmail }) {
  const auth = await getAuthClientForOrg(orgId, 'google_calendar');
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary: title,
    description,
    location,
    start: { dateTime: startTime, timeZone: 'Asia/Jerusalem' },
    end:   { dateTime: endTime,   timeZone: 'Asia/Jerusalem' }
  };

  if (attendeeEmail) {
    event.attendees = [{ email: attendeeEmail }];
  }

  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return res.data;
}

/**
 * Sync Google Calendar events into Flow's events table.
 */
async function syncCalendarEvents(orgId) {
  const googleEvents = await fetchCalendarEvents(orgId, {
    timeMin: new Date().toISOString(),
    maxResults: 50
  });

  const inserted = [];

  for (const gEvent of googleEvents) {
    // Skip events already synced
    const { data: existing } = await supabase
      .from('events')
      .select('id')
      .eq('organization_id', orgId)
      .eq('google_event_id', gEvent.id)
      .single();

    if (existing) continue;

    const startTime = gEvent.start?.dateTime || gEvent.start?.date;
    const endTime   = gEvent.end?.dateTime   || gEvent.end?.date;

    if (!startTime || !endTime) continue;

    const { data: newEvent } = await supabase
      .from('events')
      .insert({
        organization_id: orgId,
        title: gEvent.summary || 'פגישה ב-Google Calendar',
        description: gEvent.description,
        start_time: startTime,
        end_time: endTime,
        location: gEvent.location,
        google_event_id: gEvent.id,
        reminder_sent: false,
        reminder_minutes: 30
      })
      .select()
      .single();

    if (newEvent) inserted.push(newEvent);
  }

  return { synced: inserted.length, events: inserted };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  encryptToken,
  decryptToken,
  setupGmailWatch,
  fetchGmailMessages,
  sendGmail,
  fetchCalendarEvents,
  createCalendarEvent,
  syncCalendarEvents
};
