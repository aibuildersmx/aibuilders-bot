# Aiby 👁️ — AI Builders MX Community Bot

WhatsApp bot for the AI Builders MX community. Powered by [Baileys](https://github.com/WhiskeySockets/Baileys) + [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

## What it does

- **Community assistant** — Answers questions about AI, dev tools, LLMs, agents, and building products
- **Group context awareness** — Reads recent group messages to understand ongoing conversations
- **Daily summaries** — Admins can request recaps of the day's discussions via the `get_group_messages` tool. Senders are rendered as `FirstName (…1234)` using the contact store built from WhatsApp `pushName`
- **Message logging** — Stores all group messages in daily `.jsonl` files for analysis
- **Contact store** — Persists phone → first name mapping at `CONTACTS_FILE` so recaps attribute messages by name
- **Link enrichment** — Uses Firecrawl + Haiku to summarize shared links in context

## Architecture

```
WhatsApp ← Baileys → Message Handler → Anthropic Messages API → Response (non-streaming)
                          ↓
                    .jsonl logging
```

- **Baileys** — WhatsApp Web multi-device connection
- **Anthropic SDK** — Direct calls to the Messages API; one JSONL session per JID on the volume
- **Tools** — `get_group_messages` (admin-only, for summaries). No streaming; final parsed reply is sent as one WhatsApp message
- **Express** — Health check + messages API
- **Railway** — Deployment with persistent volume at `/data`

## Security

- **Minimal tool surface** — Only `get_group_messages` (admin-only). No filesystem, shell, or network tools
- **Hardened system prompt** — Anti-injection rules in AGENTS.md
- **Role-based access** — `ADMIN_USERS` for summaries/analysis, `ALLOWED_USERS` for general access
- **Group allowlist** — Only responds in `ALLOWED_GROUPS`
- **Rate limiting** — Per-user sliding window
- **API key auth** — Messages API requires `x-api-key` header

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | **Required.** Anthropic API key (billed to your API account) |
| `BOT_PREFIX` | Trigger word (default: `aiby`) |
| `ALLOWED_GROUPS` | Comma-separated group JIDs |
| `ALLOWED_USERS` | Comma-separated user IDs (empty = all) |
| `ADMIN_USERS` | Comma-separated admin IDs (for summaries) |
| `BAILEYS_AUTH_DIR` | Path to Baileys session (default: `/data/baileys-auth`) |
| `SESSIONS_DIR` | Chat JSONL sessions dir (default: `/data/sessions`) |
| `AGENTS_MD_PATH` | System prompt path (default: `/data/agent/AGENTS.md`) |
| `MESSAGES_DIR` | Message logs dir (default: `/data/messages`) |
| `IMAGES_DIR` | Downloaded image dir (default: `/data/images`) |
| `CONTACTS_FILE` | Contact store JSON path (default: `/data/contacts.json`) |
| `API_KEY` | API key for messages endpoint |
| `BAILEYS_AUTH_B64` | Base64 Baileys auth (for first deploy) |
| `FIRECRAWL_API_KEY` | Firecrawl API key (link enrichment) |
| `PORT` | HTTP server port (default: `3000`) |
| `RATE_LIMIT_MAX` | Max messages per window (default: `10`) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms (default: `3600000`) |

## API Endpoints

```
GET /health                    — Bot status
GET /messages?key=KEY          — List message files
GET /messages/:file?key=KEY    — Get messages from a file
```

Message files follow the pattern `YYYY-MM-DD_groupname.jsonl`.

## Local Development

```bash
cp .env.example .env  # configure variables
npm install
npm run dev           # runs with tsx watch
```

Scan the QR code with WhatsApp to connect.

## Deployment (Railway)

1. `railway link` to connect project
2. Set environment variables
3. Add volume mounted at `/data`
4. `railway up` to deploy
5. Check `railway logs` for QR code on first deploy

## Group Name Mapping

Configure group JIDs via the `GROUP_NAMES` environment variable:

```
GROUP_NAMES=120363xxx@g.us:general,120363yyy@g.us:leads
```

To find group JIDs, check bot logs when it connects — it prints all group memberships.

## License

Private — AI Builders MX
