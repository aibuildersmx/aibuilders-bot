/**
 * WhatsApp connection via Baileys.
 * Handles QR auth, session persistence, reconnection, and message routing.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
  isJidGroup,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { isAllowed, isAdmin, isOpenGroup, isGroupAllowed, trackMessage, checkGroupCooldown } from "./guards.js";
import { prompt as agentPrompt, resetSession } from "./agent.js";
import { upsertContact, getContactLabel } from "./contacts.js";
import { cdmxDateString, cdmxDateStringOffset } from "./time.js";

const logger = pino({ level: "silent" }); // Baileys is VERY noisy

const AUTH_DIR = process.env.BAILEYS_AUTH_DIR ?? "/data/baileys-auth";
const BOT_PREFIX = process.env.BOT_PREFIX ?? "aiby";

// WhatsApp message length limit
const MAX_WA_MESSAGE = 4096;

const MESSAGES_DIR = process.env.MESSAGES_DIR ?? "/data/messages";

// Map group JIDs to friendly names for file naming
// Format: "jid1:name1,jid2:name2"
const GROUP_NAMES: Record<string, string> = Object.fromEntries(
  (process.env.GROUP_NAMES ?? "").split(",").filter(Boolean).map((entry) => {
    const [jid, name] = entry.split(":");
    return [jid.trim(), name.trim()];
  })
);

const CONTEXT_MESSAGES = 100;
const IMAGES_DIR = process.env.IMAGES_DIR ?? "/data/images";
const IMAGE_MAX_SIZE = 512;
const IMAGE_QUALITY = 60;
const IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let _anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

/**
 * Download, resize, save image AND generate a description with Haiku.
 * Returns { filename, description } or null.
 */
async function processImage(msg: any): Promise<{ filename: string; description: string } | null> {
  try {
    if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });

    const buffer = await downloadMediaMessage(msg, "buffer", {});
    if (!buffer) return null;

    // Resize and compress
    const compressed = await sharp(buffer as Buffer)
      .resize(IMAGE_MAX_SIZE, IMAGE_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: IMAGE_QUALITY })
      .toBuffer();

    // Save to disk
    const date = cdmxDateString();
    const msgId = msg.key.id ?? Date.now().toString();
    const filename = `${date}_${msgId}.jpg`;
    const filepath = join(IMAGES_DIR, filename);
    await writeFile(filepath, compressed);
    console.log(`[img] Saved ${filename} (${Math.round(compressed.length / 1024)}KB)`);

    // Describe with Haiku
    const b64 = compressed.toString("base64");
    let description = "(imagen)";
    try {
      const client = getAnthropic();
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text: "Describe esta imagen en 1-2 oraciones cortas en español. Si tiene texto, inclúyelo textualmente. Solo la descripción, nada más." },
          ],
        }],
      });
      const textBlock = response.content.find(b => b.type === "text");
      if (textBlock && textBlock.type === "text") description = textBlock.text.trim();
      console.log(`[img] Described: ${description.slice(0, 80)}`);
    } catch (err) {
      console.error("[img] Haiku description failed:", err);
    }

    return { filename, description };
  } catch (err) {
    console.error("[img] Failed to process image:", err);
    return null;
  }
}

const PDF_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Download a PDF and summarize it with Haiku using a native document block.
 * Returns { filename, summary } or null if the document can't be processed.
 */
async function processPdf(msg: any): Promise<{ filename: string; summary: string } | null> {
  try {
    const doc =
      msg.message?.documentMessage ??
      msg.message?.documentWithCaptionMessage?.message?.documentMessage;
    if (!doc) return null;
    const filename = doc.fileName ?? "document.pdf";

    const buffer = await downloadMediaMessage(msg, "buffer", {});
    if (!buffer || (buffer as Buffer).length === 0) return null;
    const size = (buffer as Buffer).length;
    console.log(`[pdf] Downloaded ${filename} (${Math.round(size / 1024)}KB)`);

    if (size > PDF_MAX_BYTES) {
      return { filename, summary: `(PDF demasiado grande: ${Math.round(size / 1024 / 1024)}MB, no se resumió)` };
    }

    const b64 = (buffer as Buffer).toString("base64");
    let summary = "(PDF)";
    try {
      const client = getAnthropic();
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: "Resume este PDF en 2-3 oraciones cortas en español. Enfócate en: qué es, de qué trata y un dato clave o conclusión. Solo el resumen, nada más." },
          ],
        }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock && textBlock.type === "text") summary = textBlock.text.trim();
      console.log(`[pdf] Summarized ${filename}: ${summary.slice(0, 80)}`);
    } catch (err) {
      console.error("[pdf] Haiku summarization failed:", err);
    }

    return { filename, summary };
  } catch (err) {
    console.error("[pdf] Failed to process PDF:", err);
    return null;
  }
}

/**
 * Clean up images older than 24 hours.
 */
function cleanupOldImages(): void {
  try {
    if (!existsSync(IMAGES_DIR)) return;
    const now = Date.now();
    const files = readdirSync(IMAGES_DIR);
    let cleaned = 0;
    for (const file of files) {
      const filepath = join(IMAGES_DIR, file);
      const stat = statSync(filepath);
      if (now - stat.mtimeMs > IMAGE_MAX_AGE_MS) {
        unlinkSync(filepath);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[img] Cleaned up ${cleaned} old images`);
  } catch (err) {
    console.error("[img] Cleanup error:", err);
  }
}

// Run cleanup every hour
setInterval(cleanupOldImages, 60 * 60 * 1000);

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? "";
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

/**
 * Extract URLs from text, scrape with Firecrawl, summarize with Haiku.
 * Returns enriched text with link summaries appended.
 */
async function enrichLinks(text: string): Promise<string> {
  if (!FIRECRAWL_API_KEY) return text;

  const urls = text.match(URL_REGEX);
  if (!urls || urls.length === 0) return text;

  // Deduplicate and limit to 2 links per message
  const unique = [...new Set(urls)].slice(0, 2);
  const summaries: string[] = [];

  for (const url of unique) {
    try {
      // Scrape with Firecrawl
      const scrapeRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      });

      if (!scrapeRes.ok) continue;
      const scrapeData = await scrapeRes.json() as any;
      const markdown = scrapeData?.data?.markdown;
      if (!markdown || markdown.length < 50) continue;

      // Truncate to ~2000 chars for Haiku
      const truncated = markdown.slice(0, 2000);

      // Summarize with Haiku
      const client = getAnthropic();
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: `Resume este contenido web en 1-2 oraciones en español. Solo el resumen, nada más.\n\nURL: ${url}\n\n${truncated}`,
        }],
      });

      const block = response.content.find((b: any) => b.type === "text");
      if (block && block.type === "text" && block.text.trim()) {
        summaries.push(`[🔗 ${url} — ${block.text.trim()}]`);
      }
    } catch (err) {
      console.error(`[link] Failed to enrich ${url}:`, err);
    }
  }

  if (summaries.length === 0) return text;
  return `${text}\n${summaries.join("\n")}`;
}

/**
 * Get recent group messages for context injection.
 */
function getRecentMessages(jid: string): string {
  try {
    const groupName = GROUP_NAMES[jid] ?? jid.replace(/[^a-zA-Z0-9]/g, "_");
    const today = cdmxDateString();
    const file = join(MESSAGES_DIR, `${today}_${groupName}.jsonl`);

    // Also check old format and yesterday
    const yesterday = cdmxDateStringOffset(-1);
    const files = [
      join(MESSAGES_DIR, `${yesterday}_${groupName}.jsonl`),
      join(MESSAGES_DIR, `${yesterday}.jsonl`),
      join(MESSAGES_DIR, `${today}.jsonl`),
      file,
    ];

    let allMessages: Array<{ ts: string; sender: string; text: string }> = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // Filter by group if old format has group field
          if (msg.group && msg.group !== jid) continue;
          allMessages.push(msg);
        } catch {}
      }
    }

    // Take last N
    const recent = allMessages.slice(-CONTEXT_MESSAGES);
    if (recent.length === 0) return "";

    return recent.map(m => {
      const time = new Date(m.ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
      return `[${time}] ${getContactLabel(m.sender)}: ${m.text}`;
    }).join("\n");
  } catch (err) {
    console.error("[context] Failed to read recent messages:", err);
    return "";
  }
}

/**
 * Get ALL messages from today for a group (for admin summaries).
 */
function getAllTodayMessages(jid: string): string {
  try {
    const groupName = GROUP_NAMES[jid] ?? jid.replace(/[^a-zA-Z0-9]/g, "_");
    const today = cdmxDateString();
    const files = [
      join(MESSAGES_DIR, `${today}.jsonl`),
      join(MESSAGES_DIR, `${today}_${groupName}.jsonl`),
    ];

    let allMessages: Array<{ ts: string; sender: string; text: string }> = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.group && msg.group !== jid) continue;
          allMessages.push(msg);
        } catch {}
      }
    }

    if (allMessages.length === 0) return "";

    return allMessages.map(m => {
      const time = new Date(m.ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
      return `[${time}] ${getContactLabel(m.sender)}: ${m.text}`;
    }).join("\n");
  } catch (err) {
    console.error("[context] Failed to read today's messages:", err);
    return "";
  }
}

/**
 * Log a reaction to `{date}_{group}_reactions.jsonl`.
 * Empty `emoji` means the reactor removed their reaction.
 * Reactions are joined to messages by `targetId` at read time.
 */
function logReaction(jid: string, targetId: string, reactor: string, emoji: string, timestamp: number): void {
  try {
    if (!existsSync(MESSAGES_DIR)) mkdirSync(MESSAGES_DIR, { recursive: true });
    const date = cdmxDateString(new Date(timestamp * 1000));
    const groupName = GROUP_NAMES[jid] ?? jid.replace(/[^a-zA-Z0-9]/g, "_");
    const file = join(MESSAGES_DIR, `${date}_${groupName}_reactions.jsonl`);
    const entry = JSON.stringify({
      ts: new Date(timestamp * 1000).toISOString(),
      targetId,
      reactor,
      emoji,
    });
    appendFileSync(file, entry + "\n");
  } catch (err) {
    console.error("[log] Failed to log reaction:", err);
  }
}

/**
 * Log a group message to a daily .jsonl file, separated by group.
 * `id` is the WhatsApp message id, needed to join reactions at read time.
 */
function logMessage(jid: string, id: string | null | undefined, senderId: string, text: string, timestamp: number): void {
  try {
    if (!existsSync(MESSAGES_DIR)) mkdirSync(MESSAGES_DIR, { recursive: true });
    const date = cdmxDateString(new Date(timestamp * 1000));
    const groupName = GROUP_NAMES[jid] ?? jid.replace(/[^a-zA-Z0-9]/g, "_");
    const file = join(MESSAGES_DIR, `${date}_${groupName}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date(timestamp * 1000).toISOString(),
      id: id ?? undefined,
      sender: senderId,
      text,
    });
    appendFileSync(file, entry + "\n");
  } catch (err) {
    console.error("[log] Failed to log message:", err);
  }
}

let sock: WASocket | null = null;
let retryCount = 0;
const MAX_RETRIES = 10;

/**
 * Extract plain text from a WhatsApp message.
 */
function extractText(message: any): string | null {
  return (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    message?.documentMessage?.caption ??
    message?.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    null
  );
}

/**
 * Check if the bot is mentioned or addressed in a message.
 */
function isBotMentioned(text: string): boolean {
  const lower = text.toLowerCase();
  const prefix = BOT_PREFIX.toLowerCase();
  // Match "aiby" as a standalone word anywhere in the message
  const regex = new RegExp(`(?:^|\\s|@)${prefix}(?:\\s|$|[,.:!?])`, "i");
  return regex.test(lower) || lower.startsWith(prefix) || lower.endsWith(prefix);
}

/**
 * Strip the bot mention from the message text to get the actual query.
 */
function stripMention(text: string): string {
  const regex = new RegExp(`@?${BOT_PREFIX}[,.:!?\\s]*`, "gi");
  return text.replace(regex, "").trim();
}

/**
 * Split long messages into WhatsApp-safe chunks.
 */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_WA_MESSAGE) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_WA_MESSAGE) {
    let splitAt = remaining.lastIndexOf("\n\n", MAX_WA_MESSAGE);
    if (splitAt === -1 || splitAt < 200) splitAt = remaining.lastIndexOf("\n", MAX_WA_MESSAGE);
    if (splitAt === -1 || splitAt < 200) splitAt = MAX_WA_MESSAGE;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Send a reply, quoting the original message.
 */
async function sendReply(jid: string, text: string, quotedMsg?: any): Promise<void> {
  if (!sock) return;

  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    await sock.sendMessage(jid, { text: chunks[i] }, i === 0 && quotedMsg ? { quoted: quotedMsg } : undefined);
  }
}

/**
 * Handle an incoming group message.
 */
async function handleGroupMessage(jid: string, senderId: string, text: string, rawMsg: any): Promise<void> {
  // Guard: is this group allowed?
  if (!isGroupAllowed(jid)) return;

  // Guard: is the bot mentioned?
  if (!isBotMentioned(text)) return;

  // Guard: is this user allowed? Open groups allow everyone, others check allowlist
  const userId = senderId.split("@")[0];
  if (!isOpenGroup(jid) && !isAllowed(userId)) return;

  // Guard: group cooldown (layered with per-user rate limit)
  if (!checkGroupCooldown(jid)) return;

  // Guard: per-user rate limit
  const allowed = trackMessage(userId);
  if (!allowed) {
    await sendReply(jid, "👁️ Demasiados mensajes. Espera un momento.", rawMsg);
    return;
  }

  const query = stripMention(text);
  if (!query) {
    await sendReply(jid, "👁️ ¿En qué te ayudo? Escribe tu pregunta después de mencionarme.", rawMsg);
    return;
  }

  console.log(`[wa] Query from ${userId} in ${jid}: ${query.slice(0, 80)}`);

  // Slash commands are admin-only
  const isSlashCommand = query.startsWith("/");
  if (isSlashCommand && !isAdmin(userId)) return;

  // /reset — archive the session so the next turn starts with empty history.
  const resetCommands = ["/reset", "/limpiar", "/olvida", "/clear"];
  if (resetCommands.some((cmd) => query.toLowerCase().startsWith(cmd))) {
    await resetSession(jid);
    await sendReply(jid, "👁️ Sesión limpia.", rawMsg);
    return;
  }

  // Detect admin summary/analysis commands
  const adminCommands = ["/resumen", "/summary", "/stats", "/reporte", "/report", "/análisis", "/analisis"];
  const isAdminQuery = adminCommands.some(cmd => query.toLowerCase().startsWith(cmd));

  // Send "thinking" indicator
  await sock?.sendPresenceUpdate("composing", jid);

  // Inject group conversation as context
  // For summary/analysis requests from admins, load full day; otherwise last 50
  const isFullContext = isAdminQuery && isAdmin(userId);
  const recentChat = isFullContext ? getAllTodayMessages(jid) : getRecentMessages(jid);
  const contextLabel = isFullContext
    ? "TODOS los mensajes del día en el grupo"
    : "últimos mensajes de la conversación";
  const contextPrefix = recentChat
    ? `[CONTEXTO DEL GRUPO — ${contextLabel}, NO los menciones explícitamente, solo úsalos para entender de qué se habla]\n${recentChat}\n\n[PREGUNTA DEL USUARIO]\n`
    : "";
  const senderLabel = getContactLabel(senderId);
  const fullQuery = `[REMITENTE: ${senderLabel}]\n${contextPrefix}${query}`;

  try {
    const response = (await agentPrompt(jid, fullQuery, { isAdmin: isAdmin(userId) })).trim()
      || "👁️ (sin respuesta)";
    await sendReply(jid, response, rawMsg);
    await sock?.sendPresenceUpdate("available", jid);
  } catch (error) {
    console.error(`[wa] Error handling message:`, error);
    await sendReply(jid, "👁️ Algo falló. Intenta de nuevo.", rawMsg);
    await sock?.sendPresenceUpdate("available", jid);
  }
}

/**
 * Connect to WhatsApp via Baileys.
 */
export async function connectWhatsApp(): Promise<WASocket> {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    // QR handled manually via qrcode-terminal
    generateHighQualityLinkPreview: false,
    // Don't sync full history — we only care about new messages
    syncFullHistory: false,
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Connection handling
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[wa] Scan this QR with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log(`[wa] Connection closed. Reason: ${reason}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect && retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
        console.log(`[wa] Reconnecting in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})`);
        setTimeout(() => connectWhatsApp(), delay);
      } else if (reason === DisconnectReason.loggedOut) {
        console.error("[wa] Logged out. Delete auth dir and re-scan QR.");
      } else {
        console.error(`[wa] Max retries reached. Exiting.`);
        process.exit(1);
      }
    }

    if (connection === "open") {
      retryCount = 0;
      console.log("[wa] ✅ Connected to WhatsApp");
    }
  });

  // Message handler
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Only process new messages (not history sync)
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip own messages
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      // Allow DMs for testing (configure via TEST_DM_JIDS env var)
      const testDmJids = (process.env.TEST_DM_JIDS ?? "").split(",").filter(Boolean);
      if (!isJidGroup(jid) && !testDmJids.includes(jid)) continue;

      // Reactions arrive as regular messages with a reactionMessage payload.
      // Capture and log before anything else — they have no text/image.
      const reaction = msg.message?.reactionMessage;
      if (reaction && isJidGroup(jid)) {
        const targetId = reaction.key?.id;
        const reactor = msg.key.participant ?? "";
        if (targetId && reactor) {
          const emoji = reaction.text ?? "";
          const ts = msg.messageTimestamp as number ?? Math.floor(Date.now() / 1000);
          logReaction(jid, targetId, reactor, emoji, ts);
        }
        continue;
      }

      const text = extractText(msg.message);
      const hasImage = !!msg.message?.imageMessage;
      const docMessage =
        msg.message?.documentMessage ??
        msg.message?.documentWithCaptionMessage?.message?.documentMessage;
      const hasPdf = !!docMessage && (docMessage.mimetype ?? "").includes("pdf");

      // Skip messages with no text, no image, and no PDF
      if (!text && !hasImage && !hasPdf) continue;

      // Track contact identity from WhatsApp pushName
      const contactSender = isJidGroup(jid) ? (msg.key.participant ?? "") : jid;
      if (contactSender) upsertContact(contactSender, msg.pushName, isJidGroup(jid) ? jid : undefined);

      // Log all group messages for analysis
      if (isJidGroup(jid)) {
        const sender = msg.key.participant ?? "";
        const msgId = msg.key.id ?? null;
        const ts = msg.messageTimestamp as number ?? Math.floor(Date.now() / 1000);

        if (hasImage) {
          // Process image in background — don't block message handling
          processImage(msg).then((result) => {
            const caption = text ?? "";
            const imgText = result
              ? `[📷 ${result.description}]${caption ? " " + caption : ""}`
              : `[📷 imagen]${caption ? " " + caption : ""}`;
            logMessage(jid, msgId, sender, imgText, ts);
          }).catch(() => {
            logMessage(jid, msgId, sender, `[📷 imagen]${text ? " " + text : ""}`, ts);
          });
        } else if (hasPdf) {
          // Process PDF in background — summarize with Haiku via native document block
          processPdf(msg).then((result) => {
            const caption = text ?? "";
            const pdfText = result
              ? `[📄 ${result.filename} — ${result.summary}]${caption ? " " + caption : ""}`
              : `[📄 PDF]${caption ? " " + caption : ""}`;
            logMessage(jid, msgId, sender, pdfText, ts);
          }).catch(() => {
            logMessage(jid, msgId, sender, `[📄 PDF]${text ? " " + text : ""}`, ts);
          });
        } else if (text) {
          // Enrich links in background
          if (URL_REGEX.test(text)) {
            URL_REGEX.lastIndex = 0; // reset regex state
            enrichLinks(text).then((enriched) => {
              logMessage(jid, msgId, sender, enriched, ts);
            }).catch(() => {
              logMessage(jid, msgId, sender, text, ts);
            });
          } else {
            logMessage(jid, msgId, sender, text, ts);
          }
        }
      }

      // Only handle text messages for bot interaction
      if (!text) continue;

      if (isJidGroup(jid)) {
        const senderId = msg.key.participant ?? "";
        await handleGroupMessage(jid, senderId, text, msg);
      } else if (testDmJids.includes(jid)) {
        // DM test mode — skip guards, respond directly
        console.log(`[wa] DM from ${jid}`);

        const dmResetCmds = ["/reset", "/limpiar", "/olvida", "/clear"];
        if (dmResetCmds.some((cmd) => text.toLowerCase().trim().startsWith(cmd))) {
          await resetSession(jid);
          await sendReply(jid, "👁️ Sesión limpia.", msg);
          continue;
        }

        await sock?.sendPresenceUpdate("composing", jid);
        try {
          const dmQuery = `[REMITENTE: ${getContactLabel(jid)}]\n${text}`;
          const userNum = jid.split("@")[0];
          const response = (await agentPrompt(jid, dmQuery, { isAdmin: isAdmin(userNum) })).trim()
            || "👁️ (sin respuesta)";
          await sendReply(jid, response, msg);
        } catch (err) {
          console.error("[wa] DM error:", err);
          await sendReply(jid, "👁️ Algo falló.", msg);
        }
      }
    }
  });

  return sock;
}

export function getSocket(): WASocket | null {
  return sock;
}
