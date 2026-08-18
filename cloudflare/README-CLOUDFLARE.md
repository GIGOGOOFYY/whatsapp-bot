# PSG WhatsApp Bot — Cloudflare deployment

This folder is a full replacement for `server.js` + Railway + MongoDB. It runs as a Cloudflare
Worker and uses:

| Old (Railway) | New (Cloudflare) |
|---|---|
| Express server, always-on | Worker `fetch` handler, serverless |
| MongoDB / Mongoose | D1 (`migrations/0001_init.sql`) |
| In-memory `conversations`/`adminSessions`/`leadSessions` | Workers KV (`src/lib/session.js`) |
| Local `/uploads` + optional Cloudinary | KV-backed media store, served back at `/media/:key` |
| Local `Rates.json` file | KV key `rates` |
| `googleapis` SDK | Direct Sheets API REST calls, signed with `jose` |
| `openai` SDK → OpenRouter | Direct `fetch` to OpenRouter |
| `axios` → Meta Graph API | Native `fetch` |

No code here depends on Railway or MongoDB — once deployed you can delete both.

## 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
cd cloudflare
npm install
```

## 2. Create the D1 database and KV namespace

```bash
wrangler d1 create psg-whatsapp-bot
# copy the "database_id" it prints into wrangler.toml -> [[d1_databases]] -> database_id

wrangler kv namespace create SESSIONS
# copy the "id" it prints into wrangler.toml -> [[kv_namespaces]] -> id
```

No R2 bucket is needed — customer photo/PDF uploads are stored in the same `SESSIONS` KV
namespace (`src/lib/media.js`). R2 requires a payment method on file to enable even on the free
tier; KV doesn't, and its free limits (1GB storage, 25MB per value, 1000 writes/day) are plenty
for occasional customer uploads on a bot this size. Files over ~18MB (rare — Meta caps images at
5MB and video at 16MB; only very large PDFs would hit this) fall back to just being logged by
media ID instead of stored.

## 3. Run the D1 migration (creates customers/inquiries/quotations/media_log tables)

```bash
npm run db:migrate:remote
```

## 4. Seed the rates KV key from your existing Rates.json

```bash
wrangler kv key put --binding=SESSIONS rates --path=../Rates.json --remote
```

## 5. Set secrets (never go in wrangler.toml)

```bash
wrangler secret put ACCESS_TOKEN        # Meta WhatsApp Cloud API token
wrangler secret put PHONE_NUMBER_ID     # Meta phone number ID
wrangler secret put ADMIN_NUMBER        # your WhatsApp number, for the rates-admin flow
wrangler secret put OPENROUTER_KEY
wrangler secret put SPREADSHEET_ID
wrangler secret put GOOGLE_CREDENTIALS  # paste the full service-account JSON as one line
```

`VERIFY_TOKEN` is set as a plain var in `wrangler.toml` (`mytoken123` by default, same as the
old code's fallback) — change it there if you use a different value, since it's not secret.

`GOOGLE_CREDENTIALS` must be the same service-account JSON you already use for Google Sheets —
just paste it in when prompted (single line is fine, wrangler reads stdin as-is).

Dropped on purpose: `MONGO_URI` (no more MongoDB), `CLOUDINARY_URL` (KV media storage replaces it).

## 6. Deploy

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://psg-whatsapp-bot.<your-subdomain>.workers.dev`.
Optionally attach a custom domain in the Cloudflare dashboard (Workers & Pages → your worker →
Settings → Domains & Routes) so the webhook URL is on `pakistansafetyglass.com.pk` instead.

## 7. Point Meta's webhook at the new URL

In [Meta for Developers](https://developers.facebook.com) → your WhatsApp app → Configuration:

- Callback URL: `https://<your-worker-url>/webhook`
- Verify token: same value as `VERIFY_TOKEN` in `wrangler.toml`

Click **Verify and Save**. Meta will hit the `GET /webhook` route, which now runs on Workers.

## 8. Test it

```bash
npm run dev          # local dev server against remote D1/KV (wrangler dev --remote if needed)
npm run tail          # live logs once deployed, replaces Railway's log viewer
```

Send yourself a WhatsApp message. Watch `wrangler tail` for the `[from]: text` log lines.

## What's the same as before

Every piece of business logic — lead wizard steps, hot-lead keyword detection, rate-update
parsing, the AI system prompt and model fallback list, the DGU/aluminum/lamination rules — is
copied unchanged from `server.js`. Only the runtime plumbing (DB, session storage, file storage,
HTTP client) changed.

## What's different / worth knowing

- **Media links are now real URLs.** Previously local files written to `/uploads` had no public
  URL unless Cloudinary was configured — now every upload gets a working `/media/<key>` link
  (served straight from KV), which also shows up correctly in the Google Sheet. That endpoint is
  public/unauthenticated by default; say the word if you want it locked down with a token.
- **Sessions expire after 6 hours** of inactivity (KV TTL) instead of living forever in memory.
  Shouldn't matter for a single quotation conversation, but means a customer can't resume a
  half-finished wizard after leaving it for days.
- **`whatsapp-web.js` and `mongoose` can be removed from the root `package.json`** — the Railway
  server used the Meta Cloud API for actual messaging, not `whatsapp-web.js`, and nothing here
  uses Mongoose. You can delete `database/`, `models/`, and the Railway `Procfile`/deploy config
  once you've confirmed the Worker is live.

## Personal-number channel (optional)

Besides the official `+923330321371` line, personal numbers can be linked so product queries
sent there also get an automatic reply — while personal chats/calls on those numbers keep working
completely normally. This is a separate always-on service, `../whatsapp-listener/`, plus a small
addition here: the `/webhook/personal` route and the admin-only `listen` command (see
`handleListenCommand`, `handlePersonalWebhook`, `computePersonalReply` in `src/index.js`).

Full setup is in `whatsapp-listener/README.md`. Short version: deploy that service somewhere
always-on, set `LISTENER_BASE_URL` here in `wrangler.toml` and `LISTENER_API_KEY` via
`wrangler secret put`, then message the official bot as admin: `listen adnan 923000306648`.

This channel is text-only for now (no photo/voice-note OCR) and shows the lead wizard as a
numbered menu instead of native buttons — see the listener's README for the full list of
differences from the official channel.
