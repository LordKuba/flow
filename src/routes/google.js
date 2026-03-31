const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');
const google = require('../services/google');

// ─── POST /api/channels/google/oauth — initiate OAuth flow ───────────────────
// Returns a URL the frontend opens in a popup/redirect
router.post('/oauth', authenticateUser, requireRole('main'), async (req, res) => {
  try {
    const { service } = req.body; // 'gmail' or 'google_calendar'
    if (!['gmail', 'google_calendar'].includes(service)) {
      return res.status(400).json({ error: 'service must be gmail or google_calendar' });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({
        error: 'Google OAuth לא מוגדר. הוסף GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET למשתני הסביבה.'
      });
    }

    // Encode org + service in state param (verified in callback)
    const state = Buffer.from(JSON.stringify({
      orgId: req.user.organization_id,
      userId: req.user.id,
      service
    })).toString('base64');

    const authUrl = google.getAuthUrl(state);
    res.json({ auth_url: authUrl, service });
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(500).json({ error: 'שגיאה ביצירת קישור OAuth' });
  }
});

// ─── GET /api/channels/google/callback — OAuth callback from Google ───────────
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/channels?error=${oauthError}`);
    }
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/channels?error=missing_params`);
    }

    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL}/settings/channels?error=invalid_state`);
    }

    const { orgId, userId, service } = stateData;

    // Exchange code for tokens
    const tokens = await google.exchangeCode(code);

    // Get user email from Google
    const { google: googleLib } = require('googleapis');
    const oauth2Client = new (require('googleapis').google.auth.OAuth2)(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials(tokens);
    const oauth2 = googleLib.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const accountEmail = userInfo.data.email;

    // Upsert channel record
    const { data: existing } = await supabase
      .from('channels')
      .select('id')
      .eq('organization_id', orgId)
      .eq('type', service)
      .single();

    const channelData = {
      organization_id: orgId,
      type: service,
      status: 'connected',
      account_name: accountEmail,
      access_token: google.encryptToken(tokens),
      refresh_token: tokens.refresh_token ? google.encryptToken({ refresh_token: tokens.refresh_token }) : null,
      token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
    };

    if (existing) {
      await supabase.from('channels').update(channelData).eq('id', existing.id);
    } else {
      await supabase.from('channels').insert(channelData);
    }

    // Redirect to frontend with success
    res.redirect(`${process.env.FRONTEND_URL}/settings/channels?connected=${service}`);
  } catch (err) {
    console.error('Google callback error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/settings/channels?error=callback_failed`);
  }
});

// ─── POST /api/channels/google/gmail/messages — fetch recent Gmail messages ───
router.post('/gmail/messages', authenticateUser, async (req, res) => {
  try {
    const messages = await google.fetchGmailMessages(req.user.organization_id);
    res.json({ messages });
  } catch (err) {
    console.error('Gmail fetch error:', err);
    res.status(500).json({ error: err.message || 'שגיאה בקריאת Gmail' });
  }
});

// ─── POST /api/channels/google/gmail/send — send an email via Gmail ──────────
router.post('/gmail/send', authenticateUser, async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject ו-body הם שדות חובה' });
    }

    await google.sendGmail(req.user.organization_id, { to, subject, body });
    res.json({ message: 'האימייל נשלח בהצלחה' });
  } catch (err) {
    console.error('Gmail send error:', err);
    res.status(500).json({ error: err.message || 'שגיאה בשליחת האימייל' });
  }
});

// ─── POST /api/channels/google/calendar/sync — sync Google Calendar → Flow ───
router.post('/calendar/sync', authenticateUser, async (req, res) => {
  try {
    const result = await google.syncCalendarEvents(req.user.organization_id);
    res.json(result);
  } catch (err) {
    console.error('Calendar sync error:', err);
    res.status(500).json({ error: err.message || 'שגיאה בסנכרון Google Calendar' });
  }
});

// ─── POST /api/channels/google/calendar/create — create event in Google Calendar
router.post('/calendar/create', authenticateUser, async (req, res) => {
  try {
    const { title, description, start_time, end_time, location, attendee_email } = req.body;
    if (!title || !start_time || !end_time) {
      return res.status(400).json({ error: 'title, start_time ו-end_time הם שדות חובה' });
    }

    const event = await google.createCalendarEvent(req.user.organization_id, {
      title, description, startTime: start_time,
      endTime: end_time, location, attendeeEmail: attendee_email
    });

    res.status(201).json(event);
  } catch (err) {
    console.error('Calendar create error:', err);
    res.status(500).json({ error: err.message || 'שגיאה ביצירת אירוע ב-Google Calendar' });
  }
});

module.exports = router;
