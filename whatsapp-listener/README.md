# PSG WhatsApp Listener — personal-number bridge

Lets product queries on personal WhatsApp numbers (yours, Adnan's, etc.) get an automatic reply
from the same bot brain as the official `+923330321371` line — without touching those numbers'
normal personal chats or calls in any way.

## How it works

This links a phone as a **companion device**, exactly like linking WhatsApp Web or WhatsApp
Desktop from Settings → Linked Devices on that phone. The phone stays the primary device: nothing
is removed, personal chats and calls keep working exactly as before. This service just reads
incoming messages, asks the Cloudflare Worker "does this need a reply and what should it say",
and if so, sends that reply back — same as the phone owner would, just automated for product
queries. Group chats are always ignored.

## Why it's a separate always-on service

The official bot (`cloudflare/`) runs on Cloudflare Workers, which only wakes up per-request and
can't run a browser session. This bridge needs a real, persistent Chromium instance to hold the
WhatsApp Web connection, so it has to run on a normal always-on server — a small VPS, or
something like Railway (same idea as the old Railway setup, just for this one small piece).

## Setup

```bash
cd whatsapp-listener
npm install
cp .env.example .env
# fill in LISTENER_API_KEY (any long random string) and WORKER_BASE_URL
# (the deployed Cloudflare Worker's URL)
npm start
```

Then on the Worker side:

```bash
cd ../cloudflare
wrangler secret put LISTENER_API_KEY   # same value as above
# set LISTENER_BASE_URL in wrangler.toml to this service's public URL, then:
npm run deploy
```

This service needs a public HTTPS URL the Worker can reach (`LISTENER_BASE_URL`). If it's running
behind a home/office connection with no public IP, a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
is the easiest way to expose it securely without opening any ports — fits naturally since the bot
already lives on Cloudflare.

## Linking a number

All linking is driven from the **official bot** — message it (as the admin) from
`+923330321371`'s chat:

```
listen adnan 923000306648
```

The bot replies with an 8-character pairing code. On Adnan's phone: WhatsApp → Settings → Linked
Devices → Link a Device → "Link with phone number instead" → enter the code. Check progress any
time with:

```
listen status adnan
```

Once it says `ready`, that number is listening. Sessions persist across restarts of this service
(saved under `.wwebjs_auth/`), so this is a one-time setup per number, not something you redo
every deploy.

## Known limitations (v1)

- **Text only.** Photos/PDFs/voice notes aren't handled on this channel yet — a customer sending
  a size-list photo here won't get the OCR treatment the official number gives. Worth building
  if this channel sees real usage; skipped for now to keep the first version small and testable.
- **No native buttons/lists.** WhatsApp Web doesn't reliably support Meta's interactive
  button/list messages, so the lead wizard falls back to a numbered text menu ("1. Tempered
  Glass...") instead — same options, just typed instead of tapped.
- **Unofficial.** This automates a personal WhatsApp account via a linked-device session, not
  Meta's sanctioned Business API. Keep usage light and product-relevant (which the query
  detection already does — it only ever replies to what looks like a PSG product question,
  everything else is left alone) to keep risk low.
