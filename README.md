# Aiby 👁️ — AI Builders MX Community Bot

WhatsApp bot for the AI Builders MX community. Powered by [Baileys](https://github.com/WhiskeySockets/Baileys) + [Pi SDK](https://github.com/mariozechner/pi-coding-agent).

## What it does

- **Community assistant** — Answers questions about AI, dev tools, LLMs, agents, and building products
- **Group context awareness** — Reads recent group messages to understand ongoing conversations
- **Daily summaries** — Admins can request recaps of the day's discussions
- **Message logging** — Stores all group messages in daily `.jsonl` files for analysis
- **Web search & scraping** — Uses Brave Search and Firecrawl silently to give better answers

## Architecture

```
WhatsApp ← Baileys → Message Handler → Pi SDK Agent → Response
                          ↓
                    .jsonl logging
```

- **Baileys** — WhatsApp Web multi-device connection
- **Pi SDK** — Agent sessions with Claude, one per group
- **Express** — Health check + messages API
- **Railway** — Deployment with persistent volume at `/data`

## Security

- **No filesystem tools** — `bash`, `read`, `write`, `edit` are disabled at SDK level (`tools: []`)
- **Hardened system prompt** — Anti-injection rules in AGENTS.md
- **Role-based access** — `ADMIN_USERS` for summaries/analysis, `ALLOWED_USERS` for general access
- **Group allowlist** — Only responds in `ALLOWED_GROUPS`
- **Rate limiting** — Per-user sliding window
- **API key auth** — Messages API requires `x-api-key` header

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BOT_PREFIX` | Trigger word (default: `aiby`) |
| `BOT_ALIASES` | Comma-separated aliases |
| `ALLOWED_GROUPS` | Comma-separated group JIDs |
| `ALLOWED_USERS` | Comma-separated user IDs (empty = all) |
| `ADMIN_USERS` | Comma-separated admin IDs (for summaries) |
| `BAILEYS_AUTH_DIR` | Path to Baileys session (default: `/data/baileys-auth`) |
| `PI_AGENT_DIR` | Path to agent config (default: `/data/agent`) |
| `PI_CWD` | Working directory (default: `/data`) |
| `PI_SESSIONS_DIR` | Agent sessions dir (default: `/data/sessions`) |
| `MESSAGES_DIR` | Message logs dir (default: `/data/messages`) |
| `API_KEY` | API key for messages endpoint |
| `BOT_AUTH_JSON` | Pi SDK auth.json contents (for first deploy) |
| `BAILEYS_AUTH_B64` | Base64 Baileys auth (for first deploy) |
| `BRAVE_API_KEY` | Brave Search API key |
| `FIRECRAWL_API_KEY` | Firecrawl API key |
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
