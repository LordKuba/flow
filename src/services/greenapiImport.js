/**
 * Green API history import service.
 *
 * Triggered automatically after a successful connect (fire-and-forget),
 * also exposed via POST /api/channels/greenapi/import.
 *
 * Strategy:
 *   1. getContacts → list of all contacts (1:1 + groups)
 *   2. Filter to MAX_CONTACTS items, both @c.us and @g.us
 *   3. For each: find/create contact + conversation, fetch last
 *      MESSAGES_PER_CHAT messages via getChatHistory, upsert messages
 *   4. Skip chats that already have messages (idempotent reruns)
 *   5. Broadcast progress via Supabase Realtime so the frontend can show a toast
 *
 * Quota notes (Developer plan):
 *   - getContacts:     1,000 calls/month
 *   - getChatHistory:    300 calls/month  ← the binding limit
 */

const { supabase } = require('../config/supabase');
const { broadcastChatImportProgress } = require('./realtime');
const greenapi = require('./greenapi');

const BASE_URL = 'https://api.green-api.com';

const IMPORT_LIMITS = {
  MAX_CONTACTS: 100,
  MESSAGES_PER_CHAT: 100,
  DELAY_BETWEEN_CALLS_MS: 250,
  SKIP_GROUPS: false, // include @g.us groups
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Public entry point. Returns immediately, runs in background.
 */
function importHistoryForOrg(orgId, channelId) {
  setImmediate(() => {
    doImport(orgId, channelId).catch((err) => {
      console.error(`[GreenAPI Import] org ${orgId} crashed:`, err);
      broadcastChatImportProgress(orgId, {
        status: 'error',
        message: err.message || 'Import failed',
      });
    });
  });
  return { started: true };
}

/**
 * Main import worker — runs in background.
 */
async function doImport(orgId, channelId) {
  console.log(`[GreenAPI Import] org ${orgId} starting`);

  // 1. Credentials
  const creds = await greenapi.getCredentials(orgId);
  if (!creds) throw new Error('Green API not configured');
  const { idInstance, apiTokenInstance } = creds;

  broadcastChatImportProgress(orgId, {
    status: 'starting',
    message: 'מתחיל ייבוא היסטוריה...',
  });

  // 2. Fetch all contacts (1 call to getContacts)
  const contactsRes = await fetch(
    `${BASE_URL}/waInstance${idInstance}/getContacts/${apiTokenInstance}`
  );
  if (!contactsRes.ok) {
    throw new Error(`getContacts HTTP ${contactsRes.status}`);
  }
  const allContacts = await contactsRes.json();
  if (!Array.isArray(allContacts)) {
    throw new Error('getContacts did not return an array');
  }

  // 3. Filter & cap
  const filtered = allContacts.filter((c) => {
    if (!c.id) return false;
    if (c.id.endsWith('@c.us')) return true;
    if (c.id.endsWith('@g.us')) return !IMPORT_LIMITS.SKIP_GROUPS;
    return false;
  });

  const toImport = filtered.slice(0, IMPORT_LIMITS.MAX_CONTACTS);
  const total = toImport.length;

  console.log(
    `[GreenAPI Import] org ${orgId}: ${allContacts.length} total, ` +
      `${filtered.length} eligible, importing ${total}`
  );

  if (total === 0) {
    broadcastChatImportProgress(orgId, {
      status: 'complete',
      imported: 0,
      total: 0,
      message: 'אין שיחות לייבוא',
    });
    return;
  }

  broadcastChatImportProgress(orgId, {
    status: 'in_progress',
    imported: 0,
    total,
    message: `נמצאו ${total} שיחות לייבוא`,
  });

  // 4. Per-contact loop
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of toImport) {
    const isGroup = c.id.endsWith('@g.us');
    const phone = c.id.replace('@c.us', '').replace('@g.us', '');
    const name = c.name || c.contactName || phone;

    try {
      // Find or create contact
      const contact = await findOrCreateContact(orgId, phone, name, isGroup);
      if (!contact) {
        skipped++;
        continue;
      }

      // Find or create conversation
      const conv = await findOrCreateConversation(
        orgId,
        channelId,
        contact.id,
        c.id
      );
      if (!conv) {
        skipped++;
        continue;
      }

      // Skip if conversation already has messages — don't re-import
      const { count: existingMsgCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)
        .limit(1);

      if (existingMsgCount && existingMsgCount > 0) {
        imported++; // counts toward progress for UI smoothness
        skipped++;
        if (imported % 5 === 0) emitProgress(orgId, imported, total);
        continue;
      }

      // Fetch chat history (1 getChatHistory call — counts against quota)
      const histRes = await fetch(
        `${BASE_URL}/waInstance${idInstance}/getChatHistory/${apiTokenInstance}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: c.id,
            count: IMPORT_LIMITS.MESSAGES_PER_CHAT,
          }),
        }
      );

      if (!histRes.ok) {
        const txt = await histRes.text().catch(() => '');
        console.warn(
          `[GreenAPI Import] getChatHistory ${c.id} HTTP ${histRes.status}: ${txt.substring(0, 150)}`
        );
        failed++;
        continue;
      }

      const history = await histRes.json();
      if (!Array.isArray(history) || history.length === 0) {
        imported++;
        if (imported % 5 === 0) emitProgress(orgId, imported, total);
        continue;
      }

      // Map + insert messages
      const rows = history
        .map((m) => mapHistoryMsgToRow(m, conv.id, orgId))
        .filter(Boolean);

      if (rows.length > 0) {
        // Insert; ON CONFLICT external_message_id we ignore.
        // Use insert (not upsert) since most chats are empty pre-import,
        // and the existing-messages check above already gates this.
        const { error: insertErr } = await supabase
          .from('messages')
          .insert(rows);
        if (insertErr) {
          console.warn(
            `[GreenAPI Import] message insert error for ${c.id}: ${insertErr.message}`
          );
        } else {
          // Update conversation last_message_at + last_message_text from newest
          // (history comes back newest-first per the API docs)
          const newest = rows[0];
          await supabase
            .from('conversations')
            .update({
              last_message_at: newest.created_at,
              last_message_text: newest.content,
            })
            .eq('id', conv.id);
        }
      }

      imported++;
      if (imported % 5 === 0) emitProgress(orgId, imported, total);
    } catch (err) {
      console.error(`[GreenAPI Import] contact ${c.id} error:`, err.message);
      failed++;
    }

    // Polite delay between getChatHistory calls
    await sleep(IMPORT_LIMITS.DELAY_BETWEEN_CALLS_MS);
  }

  console.log(
    `[GreenAPI Import] org ${orgId} complete: imported=${imported} skipped=${skipped} failed=${failed} total=${total}`
  );

  broadcastChatImportProgress(orgId, {
    status: 'complete',
    imported,
    total,
    message: `הסתיים — ${imported}/${total} שיחות יובאו (${skipped} דולגו, ${failed} נכשלו)`,
  });
}

function emitProgress(orgId, imported, total) {
  broadcastChatImportProgress(orgId, {
    status: 'in_progress',
    imported,
    total,
    message: `מייבא ${imported}/${total}...`,
  });
}

/**
 * Map a getChatHistory message object to a `messages` row.
 * NOTE: getChatHistory's flat shape differs from the webhook's nested
 * messageData shape — fields like textMessage / caption / typeMessage are
 * directly on the root object here.
 */
function mapHistoryMsgToRow(m, convId, orgId) {
  if (!m.idMessage) return null;

  const direction = m.type === 'incoming' ? 'in' : 'out';
  let type = 'text';
  let content = '';

  switch (m.typeMessage) {
    case 'textMessage':
    case 'extendedTextMessage':
      content = m.textMessage || '';
      break;
    case 'imageMessage':
      type = 'image';
      content = m.caption || '[תמונה]';
      break;
    case 'videoMessage':
      type = 'video';
      content = m.caption || '[סרטון]';
      break;
    case 'audioMessage':
    case 'voiceMessage':
      type = 'audio';
      content = '[הודעה קולית]';
      break;
    case 'documentMessage':
      type = 'document';
      content = m.fileName || m.caption || '[קובץ]';
      break;
    case 'stickerMessage':
      type = 'image';
      content = '[מדבקה]';
      break;
    case 'locationMessage':
      content = '[מיקום]';
      break;
    case 'contactMessage':
      content = '[איש קשר]';
      break;
    case 'pollMessage':
      content = `[סקר] ${m.pollMessageData?.name || ''}`;
      break;
    default:
      content = '[הודעה]';
  }

  return {
    conversation_id: convId,
    organization_id: orgId,
    external_message_id: m.idMessage,
    direction,
    type,
    content,
    media_url: m.downloadUrl || null,
    is_read: true, // historical — don't pop unread badges
    created_at: m.timestamp
      ? new Date(m.timestamp * 1000).toISOString()
      : new Date().toISOString(),
  };
}

async function findOrCreateContact(orgId, phone, name, isGroup) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('id')
    .eq('organization_id', orgId)
    .eq('phone', phone)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      organization_id: orgId,
      name,
      phone,
      source_channel: 'whatsapp',
      type: 'lead',
      status: 'new',
      // Note: groups are stored as a "contact" with phone = group jid
      // (matches what handleIncomingMessage already does)
    })
    .select()
    .single();

  if (error) {
    console.error(`[GreenAPI Import] create contact failed (${phone}):`, error.message);
    return null;
  }
  return created;
}

async function findOrCreateConversation(orgId, channelId, contactId, externalChatId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('organization_id', orgId)
    .eq('contact_id', contactId)
    .eq('channel_id', channelId)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      channel_id: channelId,
      channel_type: 'whatsapp',
      external_chat_id: externalChatId,
      status: 'open',
    })
    .select()
    .single();

  if (error) {
    console.error(`[GreenAPI Import] create conversation failed:`, error.message);
    return null;
  }
  return created;
}

module.exports = {
  importHistoryForOrg,
};
