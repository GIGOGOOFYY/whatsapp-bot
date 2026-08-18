-- PSG WhatsApp Bot — D1 schema
-- Replaces MongoDB/Mongoose (models/Customer.js, Inquiry.js, Quotation.js)

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  company TEXT,
  city TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  message TEXT,
  response TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  glass_type TEXT,
  width_mm REAL,
  height_mm REAL,
  pieces INTEGER,
  layers INTEGER,
  sqft REAL,
  rate REAL,
  total REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Media log (replaces local /uploads writes — actual bytes go to the SESSIONS KV namespace,
-- see src/lib/media.js; this just indexes them. addMediaAttachment() also mirrors to Sheets)
CREATE TABLE IF NOT EXISTS media_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  media_type TEXT,
  mime_type TEXT,
  media_key TEXT,
  caption TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inquiries_phone ON inquiries(customer_phone);
CREATE INDEX IF NOT EXISTS idx_quotations_phone ON quotations(customer_phone);
CREATE INDEX IF NOT EXISTS idx_media_log_phone ON media_log(customer_phone);
