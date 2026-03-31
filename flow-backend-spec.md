# Flow – מסמך תשתית Backend מלא

> **מטרה:** מסמך זה הוא הבסיס לבניית ה-Backend של Flow עם Claude Code.
> כל שלב נבנה בנפרד, נבדק, ורק אז ממשיכים הלאה.
> עודכן: מרץ 2026

---

## 🎯 מה זה Flow?

Flow היא **פלטפורמת ניהול עסק חכמה** (לא רק CRM) לעסקים קטנים ובינוניים בישראל. כוללת:
- Inbox רב-ערוצי (WhatsApp, Instagram, Facebook, Gmail)
- ניהול לידים ולקוחות
- ניהול משימות עם עדיפויות ודדליינים
- יומן ופגישות
- הצעות מחיר ובקשות תשלום
- מזכירה AI (GPT-4o Mini)
- בוט אוטומטי (אחרי WhatsApp API רשמי)
- אוטומציות וכללים
- ניהול צוות עם הרשאות

---

## 🏗️ ארכיטקטורה כללית

```
[React Frontend - Vercel/Netlify]
         ↕ HTTPS API calls
[Express.js Backend - Railway EU]
         ↕
[Supabase - West EU Ireland]
   ├── PostgreSQL (מסד נתונים)
   ├── Auth (אימות משתמשים)
   ├── Realtime (הודעות בזמן אמת)
   └── Storage (קבצים ומדיה)
         ↕
[ערוצי תקשורת חיצוניים]
   ├── WhatsApp (whatsapp-web.js / Meta Cloud API)
   ├── Instagram (Meta Graph API)
   ├── Facebook Messenger (Meta Graph API)
   ├── Gmail (Google OAuth)
   └── Google Calendar (Google OAuth)
         ↕
[שירותי AI]
   └── OpenAI GPT-4o Mini (מזכירה AI + בוט)
```

---

## 📦 Stack טכנולוגי

| שכבה | טכנולוגיה | סיבה |
|------|-----------|-------|
| Backend Framework | Express.js | מוכר, קל, Claude Code מכיר היטב |
| מסד נתונים | Supabase (PostgreSQL) | כבר מוגדר, Auth+Realtime כלולים |
| Auth | Supabase Auth | מובנה, חינם עד 50K משתמשים |
| Real-time | Supabase Realtime | כלול, מתאים ל-Inbox |
| WhatsApp QR | whatsapp-web.js | יציב, סיכון באן נמוך |
| WhatsApp רשמי | Meta Cloud API | אחרי אישור (הלקוח מחבר בעצמו) |
| Instagram/FB | Meta Graph API | חינם, אחרי אישור |
| Gmail/Calendar | Google OAuth | Testing mode זמין מיד |
| AI | OpenAI GPT-4o Mini | זול פי 3, עברית טובה |
| Deployment | Railway EU | WebSocket, קרוב ל-Supabase Ireland |
| Frontend | Vercel/Netlify | חינם, מתאים ל-React |

---

## 🗄️ סכמת מסד הנתונים המלאה

### טבלת `organizations` (עסקים)
```sql
CREATE TABLE organizations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,                          -- שם העסק
  business_id TEXT,                            -- ח.פ / ע.מ
  email TEXT,                                  -- מייל עסקי
  phone TEXT,                                  -- טלפון עסקי
  address TEXT,                                -- כתובת
  logo_url TEXT,                               -- לוגו
  plan TEXT DEFAULT 'beta',                    -- beta / pro / pro_plus
  plan_expires_at TIMESTAMP,                   -- תאריך פקיעת חבילה
  ai_calls_used INTEGER DEFAULT 0,             -- שימוש ב-AI החודש
  ai_calls_limit INTEGER DEFAULT 100,          -- מכסת AI (100 בטא, 1000 Pro)
  working_hours JSONB,                         -- שעות פעילות לבוט
  bot_enabled BOOLEAN DEFAULT FALSE,           -- בוט פעיל/כבוי
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `users` (משתמשים/נציגים)
```sql
CREATE TABLE users (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'agent',                   -- main / manager / agent
  is_active BOOLEAN DEFAULT TRUE,
  invited_by UUID REFERENCES users(id),        -- מי הזמין
  invited_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `channels` (ערוצי תקשורת מחוברים)
```sql
CREATE TABLE channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  type TEXT NOT NULL,                          -- whatsapp_qr / whatsapp_api / instagram / facebook / gmail / google_calendar
  status TEXT DEFAULT 'disconnected',          -- connected / disconnected / error
  phone_number TEXT,                           -- לווצאפ
  account_name TEXT,                           -- שם החשבון
  access_token TEXT,                           -- OAuth token מוצפן
  refresh_token TEXT,                          -- Refresh token מוצפן
  token_expires_at TIMESTAMP,
  webhook_verified BOOLEAN DEFAULT FALSE,
  meta_phone_id TEXT,                          -- ל-WhatsApp Cloud API
  meta_waba_id TEXT,                           -- WhatsApp Business Account ID
  session_data TEXT,                           -- נתוני session לווצאפ QR (מוצפן)
  disclaimer_accepted BOOLEAN DEFAULT FALSE,   -- לקוח קיבל דיסקליימר QR
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `contacts` (לידים ולקוחות)
```sql
CREATE TABLE contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  business_name TEXT,
  source_channel TEXT,                         -- whatsapp / instagram / facebook / gmail
  type TEXT DEFAULT 'lead',                    -- lead / customer
  status TEXT DEFAULT 'new',                   -- לידים: new/in_progress/quote_sent/future_customer/not_relevant
                                               -- לקוחות: quote_sent/active_order/ready_for_delivery/pending_payment/closed
  assigned_to UUID REFERENCES users(id),       -- נציג משויך
  notes TEXT,
  tags TEXT[],                                 -- תגיות
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `conversations` (שיחות)
```sql
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  contact_id UUID REFERENCES contacts(id),
  channel_id UUID REFERENCES channels(id),
  channel_type TEXT,                           -- whatsapp / instagram / facebook / gmail
  external_chat_id TEXT,                       -- ID השיחה בפלטפורמה החיצונית
  assigned_to UUID REFERENCES users(id),
  status TEXT DEFAULT 'open',                  -- open / closed
  unread_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMP,
  last_message_text TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `messages` (הודעות)
```sql
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  organization_id UUID REFERENCES organizations(id),
  external_message_id TEXT,                    -- ID ההודעה בפלטפורמה
  direction TEXT NOT NULL,                     -- in / out
  type TEXT DEFAULT 'text',                    -- text / image / audio / video / document / contact
  content TEXT,                                -- תוכן ההודעה
  media_url TEXT,                              -- קישור למדיה
  media_type TEXT,                             -- image/jpeg, audio/ogg וכו'
  sent_by UUID REFERENCES users(id),           -- מי שלח (לצד שלנו)
  is_read BOOLEAN DEFAULT FALSE,
  is_bot_message BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `tasks` (משימות)
```sql
CREATE TABLE tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  contact_id UUID REFERENCES contacts(id),
  conversation_id UUID REFERENCES conversations(id),  -- משימה שנוצרה מהודעה
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',              -- high / medium / low
  status TEXT DEFAULT 'open',                  -- open / in_progress / done
  assigned_to UUID REFERENCES users(id),
  due_date DATE,
  source_message TEXT,                         -- טקסט ההודעה המקורית
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `events` (פגישות)
```sql
CREATE TABLE events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  contact_id UUID REFERENCES contacts(id),
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  location TEXT,
  location_type TEXT,                          -- physical / phone / video
  google_event_id TEXT,                        -- ID ב-Google Calendar
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `documents` (הצעות מחיר ובקשות תשלום)
```sql
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  contact_id UUID REFERENCES contacts(id),
  type TEXT NOT NULL,                          -- quote / payment_request
  amount DECIMAL(10,2),
  currency TEXT DEFAULT 'ILS',
  description TEXT,
  due_date DATE,
  status TEXT DEFAULT 'open',                  -- open / pending / paid / closed
  external_doc_id TEXT,                        -- ID בחשבונית חיצונית
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `automations` (אוטומציות)
```sql
CREATE TABLE automations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  trigger_type TEXT,                           -- new_lead / no_reply / schedule / keyword
  trigger_config JSONB,                        -- הגדרות הטריגר
  action_type TEXT,                            -- send_message / create_task / assign_contact
  action_config JSONB,                         -- הגדרות הפעולה
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `notifications` (התראות)
```sql
CREATE TABLE notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  user_id UUID REFERENCES users(id),
  type TEXT,                                   -- new_message / task_assigned / meeting_soon / document_opened
  title TEXT,
  body TEXT,
  reference_id UUID,                           -- ID של הרשומה הרלוונטית
  reference_type TEXT,                         -- conversation / task / event / document
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### טבלת `ai_calls` (מעקב שימוש AI)
```sql
CREATE TABLE ai_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id),
  user_id UUID REFERENCES users(id),
  type TEXT,                                   -- chat / suggest_reply / transcribe / bot
  tokens_used INTEGER,
  cost_usd DECIMAL(10,6),
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🛣️ API Routes מלאים

### Auth
```
POST /api/auth/register          -- הרשמה חדשה
POST /api/auth/login             -- כניסה
POST /api/auth/logout            -- יציאה
POST /api/auth/refresh           -- חידוש token
POST /api/auth/invite            -- הזמנת נציג במייל
POST /api/auth/accept-invite     -- קבלת הזמנה
GET  /api/auth/me                -- פרטי המשתמש הנוכחי
```

### Organizations
```
GET    /api/org                  -- פרטי הארגון
PUT    /api/org                  -- עדכון פרטי הארגון
GET    /api/org/team             -- רשימת הצוות
DELETE /api/org/team/:userId     -- הסרת נציג
PUT    /api/org/team/:userId     -- עדכון תפקיד נציג
```

### Channels (ערוצים)
```
GET    /api/channels             -- כל הערוצים המחוברים
POST   /api/channels/whatsapp/qr          -- התחלת חיבור QR
GET    /api/channels/whatsapp/qr/status   -- סטטוס QR
DELETE /api/channels/:channelId           -- ניתוק ערוץ
POST   /api/channels/google/oauth         -- OAuth ל-Google
GET    /api/channels/google/callback      -- Callback מ-Google
POST   /api/channels/meta/connect        -- חיבור Meta API
GET    /api/channels/meta/callback        -- Callback מ-Meta
```

### Contacts
```
GET    /api/contacts             -- כל אנשי הקשר (לידים + לקוחות)
POST   /api/contacts             -- יצירת איש קשר
GET    /api/contacts/:id         -- פרטי איש קשר
PUT    /api/contacts/:id         -- עדכון
DELETE /api/contacts/:id         -- מחיקה
PUT    /api/contacts/:id/assign  -- שיוך לנציג
PUT    /api/contacts/:id/status  -- שינוי סטטוס
```

### Conversations (Inbox)
```
GET    /api/conversations        -- כל השיחות
GET    /api/conversations/:id    -- שיחה ספציפית
PUT    /api/conversations/:id/assign     -- שיוך שיחה
PUT    /api/conversations/:id/read       -- סימון כנקרא
POST   /api/conversations/:id/messages   -- שליחת הודעה
GET    /api/conversations/:id/messages   -- היסטוריית הודעות
```

### Webhooks (הודעות נכנסות)
```
POST /webhooks/whatsapp          -- הודעות נכנסות מ-WhatsApp QR
POST /webhooks/meta              -- הודעות נכנסות מ-WhatsApp API / Instagram / Facebook
GET  /webhooks/meta              -- אימות Meta Webhook
POST /webhooks/gmail             -- מיילים נכנסים
```

### Tasks
```
GET    /api/tasks                -- כל המשימות
POST   /api/tasks                -- יצירת משימה
PUT    /api/tasks/:id            -- עדכון משימה
DELETE /api/tasks/:id            -- מחיקת משימה
PUT    /api/tasks/:id/status     -- שינוי סטטוס
```

### Events (יומן)
```
GET    /api/events               -- כל הפגישות
POST   /api/events               -- יצירת פגישה
PUT    /api/events/:id           -- עדכון פגישה
DELETE /api/events/:id           -- מחיקת פגישה
POST   /api/events/sync-google   -- סנכרון עם Google Calendar
```

### Documents (תשלומים)
```
GET    /api/documents            -- כל המסמכים
POST   /api/documents            -- יצירת מסמך (הצעת מחיר / בקשת תשלום)
PUT    /api/documents/:id/status -- עדכון סטטוס
GET    /api/documents/contact/:contactId -- מסמכים לפי לקוח
```

### AI
```
POST /api/ai/chat                -- שאילתה למזכירה AI
POST /api/ai/suggest-reply       -- הצעת תשובה להודעה
POST /api/ai/transcribe          -- תמלול הודעה קולית
POST /api/ai/bot-reply           -- תשובת בוט ללקוח
GET  /api/ai/usage               -- מעקב שימוש
```

### Notifications
```
GET  /api/notifications          -- כל ההתראות
PUT  /api/notifications/read-all -- סימון הכל כנקרא
PUT  /api/notifications/:id/read -- סימון בודדת כנקראה
```

### Stats
```
GET /api/stats/overview          -- סטטיסטיקות כלליות
GET /api/stats/leads             -- נתוני לידים
GET /api/stats/messages          -- נתוני הודעות
GET /api/stats/revenue           -- נתוני הכנסות
```

---

## 🔐 מודל הרשאות

### 3 רמות גישה:

| פעולה | ראשי (main) | מנהל (manager) | נציג (agent) |
|-------|:-----------:|:--------------:|:------------:|
| רואה את כל השיחות | ✅ | ✅ | ❌ רק שלו |
| שולח הודעות | ✅ | ✅ | ✅ רק שיחות שלו |
| משייך שיחות לנציגים | ✅ | ✅ | ❌ |
| מוסיף נציגים | ✅ | ✅ | ❌ |
| מסיר נציגים | ✅ | ✅ | ❌ |
| מחבר/מנתק ערוצים | ✅ | ❌ | ❌ |
| משנה הגדרות עסק | ✅ | ❌ | ❌ |
| מוחק חשבון | ✅ | ❌ | ❌ |
| רואה סטטיסטיקות | ✅ | ✅ | ❌ |
| מגדיר בוט/אוטומציות | ✅ | ❌ | ❌ |
| יוצר משימות | ✅ | ✅ | ✅ |
| יוצר פגישות | ✅ | ✅ | ✅ |

### Middleware לבדיקת הרשאות:
```javascript
requireRole('main')       // רק חשבון ראשי
requireRole('manager')    // ראשי + מנהל
requireRole('agent')      // כולם
requireOwnConversation()  // נציג יכול לגשת רק לשיחות שלו
```

---

## 📡 Real-time עם Supabase

### אירועים שמשודרים בזמן אמת:
- **הודעה חדשה נכנסת** → כל המשתמשים באותו ארגון
- **שיחה שויכה לנציג** → הנציג שקיבל + ראשי/מנהל
- **משימה חדשה** → הנציג שהוקצה
- **מסמך נפתח/נסגר** → כל הצוות
- **פגישה מתחילה בעוד 30 דקות** → כל הצוות

### ארכיטקטורה:
```
הודעה נכנסת (WhatsApp/IG/FB/Gmail)
    ↓
Webhook → Express Backend
    ↓
INSERT לטבלת messages ב-Supabase
    ↓
Supabase Realtime מפעיל שידור
    ↓
React Frontend מקבל עדכון מיידי
```

---

## 📱 חיבורי WhatsApp

### מסלול 1 – QR (בטא)
```
לקוח לוחץ "חבר WhatsApp"
    ↓
דיסקליימר: "חיבור זה אינו רשמי. הלקוח אחראי לעמוד בתנאי WhatsApp"
    ↓
לקוח מאשר → QR code מוצג
    ↓
לקוח סורק עם WhatsApp Business שלו
    ↓
whatsapp-web.js שומר session
    ↓
הודעות זורמות ל-Inbox
```

### מסלול 2 – Meta Cloud API (גרסה רשמית)
```
לקוח פותח חשבון Meta Business שלו
    ↓
Flow מספקת הוראות חיבור
    ↓
לקוח מגדיר Webhook ל-Flow
    ↓
כל חיובי Meta ישירות אצל הלקוח
    ↓
Flow מקבלת הודעות דרך Webhook
```

---

## 📲 חיבורי Meta (Instagram + Facebook)

### Flow לאחר קבלת אישור Meta Graph API:
```
לקוח לוחץ "חבר Instagram"
    ↓
OAuth redirect ל-Meta
    ↓
Meta מחזיר access_token
    ↓
Flow שומר token מוצפן ב-channels
    ↓
DMs מ-Instagram/Facebook מגיעים ל-Inbox
```

### Webhook של Meta:
```
POST /webhooks/meta
├── אימות: X-Hub-Signature-256
├── WhatsApp messages
├── Instagram DMs
└── Facebook Messenger
```

---

## 📧 חיבור Gmail + Google Calendar

### OAuth Flow:
```
לקוח לוחץ "חבר Gmail"
    ↓
redirect ל: GET /api/channels/google/oauth
    ↓
Google OAuth consent screen
    ↓
callback: GET /api/channels/google/callback
    ↓
שמירת tokens מוצפנים
    ↓
Gmail Watch: קבלת מיילים חדשים
Google Calendar: סנכרון פגישות
```

### Scopes נדרשים:
```
Gmail:    gmail.readonly + gmail.send
Calendar: calendar.events + calendar.readonly
```

---

## 🤖 מזכירה AI (GPT-4o Mini)

### מגבלות לפי חבילה:
| חבילה | בטא | גרסה רשמית |
|--------|-----|------------|
| Pro | 100/חודש | 1,000/חודש |
| Pro+ | 500/חודש | 5,000/חודש |

### שימושים:
1. **צ'אט חופשי** – שאילות ב-AI tab
2. **הצעת תשובה** – לחיצה ימנית על הודעה
3. **תמלול קולי** – Whisper API
4. **תשובת בוט** – מענה אוטומטי ללקוחות (אחרי WhatsApp API)

### לוגיקת מעקב:
```javascript
// לפני כל קריאה ל-AI:
const usage = await getMonthlyAiUsage(organizationId);
if (usage >= org.ai_calls_limit) {
  throw new Error('הגעת למכסת ה-AI החודשית');
}
await logAiCall(organizationId, userId, type, tokens, cost);
```

---

## 🔒 אבטחה

### חובה בכל endpoint:
```javascript
app.use(helmet())                    // HTTP security headers
app.use(cors({ origin: FRONTEND_URL }))
app.use(rateLimit({ windowMs: 15min, max: 100 }))
app.use(authenticateUser)            // Supabase JWT validation
```

### הצפנה:
- כל OAuth tokens מוצפנים ב-AES-256 לפני שמירה
- session data של WhatsApp מוצפן
- HTTPS בלבד (Railway מספק SSL אוטומטי)
- Webhook signatures מאומתות (Meta + Google)

### Row Level Security (Supabase RLS):
```sql
-- כל טבלה: משתמש רואה רק נתוני הארגון שלו
CREATE POLICY "org_isolation" ON contacts
  USING (organization_id = auth.jwt() ->> 'org_id');
```

---

## 📋 כללי עבודה תשתיתיים (חוק)

| כלל | פירוט |
|-----|--------|
| **גיבויים אוטומטיים יומיים** | Supabase עושה זאת אוטומטית. לא לבטל! |
| **Staging Environment** | כל גרסה נבדקת לפני העלאה לייצור |
| **Database Migrations בזהירות** | כל שינוי בסכמה עובר בדיקה קודם |
| **Rollback מהיר** | Railway שומר גרסאות קודמות – חזרה בלחיצה |
| **לא לשנות ייצור ישירות** | תמיד דרך migration scripts |
| **בנייה בחלקים** | כל שלב נבנה ונבדק לפני הבא |

---

## 🚀 סדר בנייה (שלב אחרי שלב)

### שלב 1 – מסד נתונים
- [ ] יצירת כל הטבלאות ב-Supabase SQL Editor
- [ ] הגדרת RLS policies
- [ ] בדיקת כל הטבלאות

### שלב 2 – שרת בסיסי
- [ ] יצירת תיקיית `flow-backend`
- [ ] התקנת Express + חבילות בסיסיות
- [ ] Server עולה ורץ על port 3001
- [ ] Health check endpoint: `GET /health`

### שלב 3 – חיבור ל-Supabase
- [ ] התקנת `@supabase/supabase-js`
- [ ] משתני סביבה (SUPABASE_URL, SUPABASE_KEY)
- [ ] בדיקת חיבור

### שלב 4 – Auth
- [ ] `POST /api/auth/register`
- [ ] `POST /api/auth/login`
- [ ] Middleware לאימות JWT
- [ ] בדיקה מלאה

### שלב 5 – Contacts + Conversations (Inbox)
- [ ] CRUD לאנשי קשר
- [ ] CRUD לשיחות
- [ ] שיוך שיחה לנציג
- [ ] חיבור Frontend לרשימת שיחות אמיתית

### שלב 6 – WhatsApp QR
- [ ] התקנת `whatsapp-web.js`
- [ ] יצירת QR code
- [ ] קבלת הודעות נכנסות
- [ ] שליחת הודעות
- [ ] שמירת הודעות ב-Supabase

### שלב 7 – Real-time
- [ ] Supabase Realtime subscriptions
- [ ] חיבור Frontend לעדכונים בזמן אמת
- [ ] badge הודעות לא נקראות

### שלב 8 – Tasks + Events
- [ ] CRUD למשימות
- [ ] CRUD לפגישות
- [ ] חיבור Frontend

### שלב 9 – Documents (תשלומים)
- [ ] CRUD להצעות מחיר
- [ ] CRUD לבקשות תשלום
- [ ] לוגיקת חסימת סטטוס

### שלב 10 – AI (GPT-4o Mini)
- [ ] מזכירה AI
- [ ] הצעת תשובה
- [ ] מעקב שימוש ומכסות

### שלב 11 – Google OAuth (Calendar + Gmail)
- [ ] OAuth flow
- [ ] סנכרון פגישות
- [ ] קבלת מיילים

### שלב 12 – Meta Graph API (IG + FB)
- [ ] OAuth flow
- [ ] Webhook אימות
- [ ] קבלת DMs
- [ ] שליחת הודעות

### שלב 13 – Notifications
- [ ] יצירת התראות אוטומטיות
- [ ] Supabase Realtime לפעמון

### שלב 14 – Automations (בוט + כללים)
- [ ] מנוע אוטומציות
- [ ] בוט AI אוטומטי
- [ ] טריגרים וכללים

### שלב 15 – דיפלוי ל-Railway
- [ ] הגדרת משתני סביבה ב-Railway
- [ ] חיבור GitHub
- [ ] דיפלוי ראשון
- [ ] בדיקת production

---

## 🔧 משתני סביבה נדרשים

```env
# Supabase
SUPABASE_URL=https://zzqmefxzdlzzppzknher.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_KEY=...

# Auth
JWT_SECRET=...

# OpenAI
OPENAI_API_KEY=...

# Meta (WhatsApp/Instagram/Facebook)
META_APP_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=...

# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=...

# Encryption
ENCRYPTION_KEY=...    # AES-256 לhokens

# App
NODE_ENV=production
PORT=3001
FRONTEND_URL=https://flowonline.co.il
```

---

## 📊 תשתית עלויות

| שירות | עלות חודשית |
|-------|------------|
| Supabase Pro | $25 |
| Railway | $5-10 |
| OpenAI GPT-4o Mini | ~$5-15 |
| Vercel/Netlify (Frontend) | $0 |
| **סה"כ** | **~$35-50** |

---

> **הערה חשובה:** מסמך זה הוא המפה המלאה של ה-Backend.
> Claude Code יעבוד לפיו שלב אחרי שלב.
> כל שינוי בסכמה או בארכיטקטורה יעודכן כאן תחילה.
