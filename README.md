# wa-readonly-mcp

Give Claude Code **read** access to your WhatsApp. A small background bridge mirrors your chats into a local
SQLite file; an MCP server lets Claude search and read them. It never sends anything — there is no send
function in the code.

```
npm install
node bridge.js          # scan the QR once
node register.js        # registers with Claude Code for every project
```

Then in any Claude Code session: *"read my last 20 messages with Sarah"*, *"what did the client say about
the deadline?"*, *"which photos in the site group got a ⭐ reaction?"*, *"transcribe Ahmed's voice notes from today"*

- **Pure Node, no native builds.** Uses Node 24's built-in SQLite. No Go, no Python, no compiler. Works on Windows.
- **Read-only by design.** The MCP server exposes nine read tools and nothing else.
- **Self-healing.** Reconnects forever with backoff; any Claude session revives a dead bridge.
- **Photos and documents too.** Attachments are downloaded so Claude can open them.
- **Voice notes, transcribed.** Optional, with a free Gemini API key. Non-English notes come back translated too.
- **Reactions.** Captured per message, so you can ask what was ⭐-ed or 👍-ed.
- **Optional allow-list.** Mirror only the chats you choose.

---

## ⚠️ Read this before you link a number

**This is an unofficial WhatsApp client and using one is against WhatsApp's Terms of Service.**
WhatsApp can ban a number for it, without warning and without appeal. This project is not affiliated
with or endorsed by WhatsApp or Meta.

In practice the risk for a read-only linked device on a home connection is low — bans are overwhelmingly
triggered by *sending*: bulk messages, spam reports, mass group creation. This bridge sends nothing. But
low is not zero, so:

- **Use a number you can afford to lose.** Don't link your only business line to test it.
- **Link once and leave it.** Repeatedly linking and unlinking is what triggers WhatsApp's
  *"Can't link new devices at this time"* throttle.
- **A cloud server is riskier than your laptop.** Datacenter IP ranges are treated with more suspicion.
- **Warm up new numbers.** A freshly registered number linked to a bot immediately is the classic ban pattern.

**Everything is stored unencrypted on your disk** — every message in every chat this account can see, plus
downloaded attachments. Treat the folder like your WhatsApp itself. See [Privacy](#privacy-and-security).

If you're not comfortable with both of those, don't use this.

---

## Requirements

- **Node.js 24 or newer** (`node --version`). SQLite is built in from 24; nothing to compile.
- Claude Code installed (`claude --version`).
- A phone with WhatsApp to scan a QR code.

## Install

```bash
git clone https://github.com/MuhammadAbdullah80/wa-readonly-mcp.git
cd wa-readonly-mcp
npm install
```

## Link your WhatsApp

```bash
node bridge.js
```

A QR code appears. On your phone: **WhatsApp → Settings → Linked devices → Link a device**, scan it.
You'll see `connected as <your number>`, then history syncing in batches.

**QR looks garbled in your terminal?** (common on Windows) Use a pairing code instead:

```bash
node bridge.js --pair +15551234567     # your own number, with country code
```

Then on the phone: *Link a device → Link with phone number instead* and type the code.

Leave the bridge running. It reconnects on its own if the connection drops. To stop it, close the
window or end the process — the store is kept.

## Register with Claude Code

```bash
node register.js
```

This runs `claude mcp add whatsapp --scope user`, so it's available in every project. Open a Claude Code
session and ask it to run `wa_status`.

The MCP server **starts the bridge automatically** if it isn't running, hidden, so after the first link you
never need to start it by hand. (Detached start needs no window on Windows; on macOS/Linux it runs as a
background process of the session that started it.)

## Voice notes (optional)

Voice notes are downloaded as they arrive. To have Claude transcribe them, get a free Gemini API key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), then:

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

and put the key in `.env`:

```
GEMINI_API_KEY=your-key-here
```

Restart Claude Code, then ask: *"transcribe the last voice notes in the site group"*.

- **Transcribed on request, never in the background.** A note goes to Gemini only when Claude calls
  `wa_transcribe` for it. The transcript is saved in `store.db`, so each note is sent once, and from
  then on it shows up in `wa_list_messages` and is found by `wa_search`.
- **Any language.** It's transcribed as spoken; anything not in English also gets an English translation.
- **Older voice notes.** Notes from history sync aren't downloaded up front — the bridge keeps a reference
  and fetches the audio when you ask, as long as WhatsApp still has it (usually a few weeks). Voice notes
  stored by a version of this bridge before transcription was added can't be fetched.
- **Free-tier limits.** Gemini's free tier allows a few requests a minute and a daily cap. A chat request
  transcribes up to 20 notes and stops cleanly if it hits the limit; ask again a minute later.
- **Model.** Uses `gemini-flash-latest`, falling back to `gemini-2.5-flash`. Set `GEMINI_MODEL` to choose.

> **Privacy:** transcribing sends that audio to Google. On Gemini's **free tier, Google may use what you
> send to improve its products**, which can include human review. Don't transcribe anything you wouldn't
> hand to Google — or use a paid (billing-enabled) key, which isn't used that way. See
> [Gemini API terms](https://ai.google.dev/gemini-api/terms).

### Windows: start at login (optional)

`start-hidden.vbs` runs the bridge with no window. Press `Win+R`, type `shell:startup`, and drop a
shortcut to it there.

## What Claude can do

| Tool | What it returns |
|---|---|
| `wa_status` | Whether the bridge is running and linked, last sync, how much is stored |
| `wa_list_chats` | Chats, newest first; filter by name; groups only |
| `wa_list_messages` | Messages from one chat, with optional date range |
| `wa_search` | Full-text search across all chats or within one |
| `wa_context` | The messages around a given message, for reading a thread |
| `wa_list_media` | Downloaded attachments in a chat, with local paths |
| `wa_media` | Local path of one attachment, so Claude can open it |
| `wa_reactions` | Emoji reactions in a chat and what they point at |
| `wa_transcribe` | Transcribes one voice note, or a chat's latest untranscribed ones, via Gemini |

There is no `wa_send`, `wa_delete`, `wa_react` or `wa_mark_read`. Not disabled — absent.

## Configuration

All optional. Set them as environment variables, or put them in a `.env` file next to `server.js`
(see `.env.example` — `.env` is git-ignored):

| Variable | Default | Purpose |
|---|---|---|
| `WA_CHATS` | *(all chats)* | Comma-separated chat JIDs to mirror. Everything else is ignored. Get JIDs from `wa_list_chats` — groups look like `1203…@g.us`, contacts like `1555…@s.whatsapp.net` |
| `WA_DATA_DIR` | the code folder | Where `store.db`, `media/` and `auth/` live |
| `WA_MAX_MEDIA_MB` | `25` | Skip attachments larger than this |
| `GEMINI_API_KEY` | *(off)* | Turns on voice-note transcription |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model to transcribe with |

To mirror only two chats, for example:

```bash
WA_CHATS="120363012345678901@g.us,15551234567@s.whatsapp.net" node bridge.js
```

Note that names of *all* chats are still recorded (so `wa_list_chats` can show you the JIDs to choose), but
message content is only stored for the listed ones.

## How it works

```
your phone ──(WhatsApp, end-to-end encrypted)──► bridge.js ──► store.db + media/
                                                                    │
                                              Claude Code ◄──stdio── server.js (MCP)
```

- **`bridge.js`** is a linked device, like WhatsApp Web, built on [Baileys](https://github.com/WhiskeySockets/Baileys).
  It receives what your phone receives and writes it to SQLite. Messages stay end-to-end encrypted in
  transit; Baileys implements the same Signal protocol as the official client.
- **`server.js`** is the MCP server. It only reads the database. It also checks the bridge is alive on
  every call and respawns it if not.
- **`transcribe.js`** — sends one voice note to Gemini when `wa_transcribe` asks; fetches it from
  WhatsApp's CDN first if it wasn't downloaded.
- **`db.js`** — schema: `chats`, `messages`, `contacts`, `reactions`, `meta`.

Images, documents, stickers and voice notes up to `WA_MAX_MEDIA_MB` are downloaded for live messages;
history sync records metadata without downloading. Video is stored as metadata only.

## Privacy and security

What's on your disk after linking:

| Path | Contents | Sensitivity |
|---|---|---|
| `auth/` | Your linked-device keys | **Equivalent to a logged-in WhatsApp Web session.** Anyone who copies this folder can read your WhatsApp until you unlink |
| `store.db` | Every message the account sees (or only `WA_CHATS`) | Plain SQLite, unencrypted |
| `media/` | Downloaded attachments and voice notes | Plain files |
| `.env` | Your Gemini API key, if set | Keep private; git-ignored |
| `bridge.log` | Connection events and counts | No message content |

- Protection is your OS login and file permissions. There is no encryption at rest. If that's not enough
  for you, put `WA_DATA_DIR` on an encrypted volume.
- **Nothing leaves your machine on its own.** The bridge only connects outbound to WhatsApp. The only
  other outbound call is `wa_transcribe`, which sends the voice notes you ask about to Google's Gemini API. The MCP server
  speaks to Claude over stdio; no port is opened. Message content reaches Claude only when Claude calls a
  tool, and then only what that call returns — which then forms part of that conversation, like anything
  pasted into it.
- Because it's registered at user scope, **every Claude Code session on the machine** can read the chats.
  Use `WA_CHATS` if that's more than you want.
- `.gitignore` excludes all of the above. Don't commit a fork with your `auth/` in it.

### Revoke and remove

- **Instantly, from your phone:** Settings → Linked devices → the *Chrome (Ubuntu)* entry → Log out. The
  bridge exits on its own.
- **Unregister from Claude:** `node register.js --remove`
- **Wipe:** delete `auth/`, `store.db*`, `media/`, `.env`.

## Things that will bite you (and how this avoids them)

These cost real hours. They're the reason this exists as a package instead of a gist.

1. **The device identity is load-bearing.** Baileys lets you pick the "browser" the linked device claims
   to be. Most values are refused at the handshake with a `428` — before any QR appears — which looks
   exactly like rate limiting, so you wait hours for a cooldown that isn't happening.
   `Browsers.ubuntu('Chrome')` works. Don't change it.
2. **`makeWASocket` is a named export in Baileys 6.17+.** `import makeWASocket from 'baileys'` gives you
   the module object and `TypeError: makeWASocket is not a function`.
3. **Don't cap reconnects.** An early version gave up after six attempts; a two-minute wifi blip produced
   six `408`s in a row and killed the daemon permanently. Retry forever with backoff, reset on success.
4. **Every reconnect must retire the old socket.** Otherwise each close spawns a new loop and you get a
   reconnect storm.
5. **Emoji reactions arrive in different encodings.** iPhones often send `⭐️` (`U+2B50 U+FE0F`), Android
   `⭐` (`U+2B50`). If you compare reactions exactly, half of them silently don't match. Strip variation
   selectors first — the store keeps the raw text, so do this when you query.
6. **Native SQLite bindings on Windows are misery.** `better-sqlite3` needs a compiler toolchain that
   matches your Node version. Node 24's `node:sqlite` needs nothing.
7. **Relinking repeatedly gets you throttled.** *"Can't link new devices at this time. Try again later."*
   Link once.

## FAQ

**Can it send messages?** No. Baileys can, but this code never calls those functions and the MCP server
exposes no such tool. Adding one is on you, and it changes the ban-risk calculation entirely.

**Does the phone need to stay online?** Linked devices work with the phone offline for up to 14 days,
after which WhatsApp unlinks them.

**Will it slow down or affect my phone?** No. `markOnlineOnConnect` is off, so it doesn't steal
notifications from the phone either.

**Can I use it with a client other than Claude Code?** Any MCP client that speaks stdio can run
`node server.js`.

**Can it transcribe without sending audio anywhere?** Not yet — transcription uses Gemini. If you need
it fully local, a Whisper-based `transcribe.js` is a drop-in replacement; PRs welcome.

**Groups?** Yes — group chats, reactions and media are all captured. The official WhatsApp Business API
can't read groups at all, which is the main reason unofficial bridges exist.

## Licence

MIT. Not affiliated with WhatsApp or Meta. Use at your own risk.
