-- Create a private storage bucket for WhatsApp session backups.
-- Sessions are encrypted with AES-256-GCM before upload.
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-sessions', 'whatsapp-sessions', false)
ON CONFLICT (id) DO NOTHING;
