const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { encrypt, decrypt } = require('./encryption');

const BUCKET = 'whatsapp-sessions';
const MAX_ARCHIVE_SIZE = 10 * 1024 * 1024; // 10 MB limit

// Only include directories that hold auth state — skip caches
const INCLUDE_DIRS = ['Local Storage', 'IndexedDB', 'Session Storage'];
const INCLUDE_FILES = ['Cookies'];

function getAuthDir(orgId) {
  return path.join(process.cwd(), '.wwebjs_auth', `session-org_${orgId}`);
}

function getStoragePath(orgId) {
  return `org_${orgId}/session.enc`;
}

/**
 * Recursively walk a directory and collect files as { path, content (base64) }
 */
function walkDir(dir, baseDir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;

  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    const relPath = path.relative(baseDir, fullPath);

    if (item.isDirectory()) {
      entries.push({ p: relPath, d: true });
      entries.push(...walkDir(fullPath, baseDir));
    } else {
      try {
        const content = fs.readFileSync(fullPath);
        entries.push({ p: relPath, c: content.toString('base64') });
      } catch {
        // Skip files we can't read (locked, etc.)
      }
    }
  }
  return entries;
}

/**
 * Save WhatsApp session to Supabase Storage after successful authentication.
 */
async function saveSession(orgId, channelId) {
  const authDir = getAuthDir(orgId);
  const defaultDir = path.join(authDir, 'Default');

  if (!fs.existsSync(defaultDir)) {
    console.log(`No session directory found for org ${orgId}, skipping save`);
    return false;
  }

  // Collect only essential auth files
  const entries = [];

  for (const dirName of INCLUDE_DIRS) {
    const dirPath = path.join(defaultDir, dirName);
    if (fs.existsSync(dirPath)) {
      entries.push(...walkDir(dirPath, defaultDir));
    }
  }

  for (const fileName of INCLUDE_FILES) {
    const filePath = path.join(defaultDir, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath);
        entries.push({ p: fileName, c: content.toString('base64') });
      } catch {
        // Skip
      }
    }
  }

  if (entries.length === 0) {
    console.log(`No auth files found for org ${orgId}, skipping save`);
    return false;
  }

  // Serialize and compress
  const json = JSON.stringify(entries);
  const compressed = zlib.gzipSync(json);

  if (compressed.length > MAX_ARCHIVE_SIZE) {
    console.warn(`Session archive for org ${orgId} is ${(compressed.length / 1024 / 1024).toFixed(1)}MB — exceeds limit, skipping`);
    return false;
  }

  // Encrypt
  const encryptedData = encrypt(compressed.toString('base64'));
  const hash = crypto.createHash('sha256').update(compressed).digest('hex');

  // Upload to Supabase Storage
  const storagePath = getStoragePath(orgId);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, encryptedData, {
      contentType: 'text/plain',
      upsert: true
    });

  if (uploadError) {
    console.error(`Failed to upload session for org ${orgId}:`, uploadError.message);
    return false;
  }

  // Save pointer to DB
  const pointer = encrypt(JSON.stringify({
    path: storagePath,
    savedAt: new Date().toISOString(),
    hash
  }));

  const { error: dbError } = await supabase
    .from('channels')
    .update({ session_data: pointer })
    .eq('id', channelId);

  if (dbError) {
    console.error(`Failed to save session pointer for org ${orgId}:`, dbError.message);
    return false;
  }

  console.log(`Session saved for org ${orgId} (${(compressed.length / 1024).toFixed(0)}KB compressed, ${entries.length} files)`);
  return true;
}

/**
 * Restore WhatsApp session from Supabase Storage before client initialization.
 */
async function restoreSession(orgId, channelId) {
  // Read pointer from DB
  const { data: channel } = await supabase
    .from('channels')
    .select('session_data')
    .eq('id', channelId)
    .single();

  if (!channel?.session_data) return false;

  const pointer = decrypt(channel.session_data);
  if (!pointer?.path || !pointer?.hash) {
    console.warn(`Invalid session pointer for org ${orgId}`);
    return false;
  }

  // Download from Storage
  const { data: fileData, error: dlError } = await supabase.storage
    .from(BUCKET)
    .download(pointer.path);

  if (dlError || !fileData) {
    console.warn(`Failed to download session for org ${orgId}:`, dlError?.message);
    return false;
  }

  try {
    const encryptedData = await fileData.text();

    // Decrypt
    const compressedB64 = decrypt(encryptedData);
    if (!compressedB64) {
      console.warn(`Failed to decrypt session for org ${orgId}`);
      return false;
    }

    const compressed = Buffer.from(compressedB64, 'base64');

    // Verify hash
    const hash = crypto.createHash('sha256').update(compressed).digest('hex');
    if (hash !== pointer.hash) {
      console.warn(`Session hash mismatch for org ${orgId} — data may be corrupt`);
      return false;
    }

    // Decompress
    const json = zlib.gunzipSync(compressed).toString('utf8');
    const entries = JSON.parse(json);

    // Reconstruct files
    const authDir = getAuthDir(orgId);
    const defaultDir = path.join(authDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });

    for (const entry of entries) {
      const fullPath = path.join(defaultDir, entry.p);
      if (entry.d) {
        fs.mkdirSync(fullPath, { recursive: true });
      } else if (entry.c) {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(entry.c, 'base64'));
      }
    }

    console.log(`Session restored for org ${orgId} (${entries.length} files)`);
    return true;
  } catch (err) {
    console.error(`Failed to restore session for org ${orgId}:`, err.message);
    return false;
  }
}

/**
 * Clear persisted session from Supabase Storage and DB.
 */
async function clearSession(orgId, channelId) {
  if (!channelId) return;

  const storagePath = getStoragePath(orgId);

  // Delete from Storage (ignore errors — file might not exist)
  await supabase.storage
    .from(BUCKET)
    .remove([storagePath])
    .catch(() => {});

  // Clear pointer in DB
  await supabase
    .from('channels')
    .update({ session_data: null })
    .eq('id', channelId)
    .catch(() => {});

  console.log(`Session cleared for org ${orgId}`);
}

module.exports = { saveSession, restoreSession, clearSession };
