/**
 * Pi SDK session manager — one agent session per WhatsApp group.
 * AI Builders Bot 🤖 — community assistant.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const agentDir = (process.env.PI_AGENT_DIR ?? "/data/agent").replace("~", process.env.HOME ?? "/root");
const cwd = process.env.PI_CWD ?? "/data";
const sessionsDir = process.env.PI_SESSIONS_DIR ?? "/data/sessions";

if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

const authPath = join(agentDir, "auth.json");
export const sharedAuthStorage = AuthStorage.create(authPath);

const sessions = new Map<string, AgentSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour for group sessions
const lastActivity = new Map<string, number>();

// ── Auth ──

export async function refreshAuth(): Promise<void> {
  try {
    await sharedAuthStorage.getApiKey("anthropic");
    console.log("[auth] Token refresh OK");
  } catch (err) {
    console.error("[auth] Token refresh failed:", err);
  }
}

export function reloadAuth(): void {
  sharedAuthStorage.reload();
  console.log("[auth] Auth storage reloaded from disk");
}

// ── Sessions ──

export async function getOrCreateSession(groupJid: string): Promise<AgentSession> {
  lastActivity.set(groupJid, Date.now());

  const existing = sessions.get(groupJid);
  if (existing) return existing;

  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();

  // Use sanitized JID as session dir name
  const safeName = groupJid.replace(/[^a-zA-Z0-9-]/g, "_");
  const chatSessionDir = join(sessionsDir, safeName);
  if (!existsSync(chatSessionDir)) mkdirSync(chatSessionDir, { recursive: true });

  let sessionManager: ReturnType<typeof SessionManager.continueRecent> | ReturnType<typeof SessionManager.create>;
  try {
    const existing = await SessionManager.list(cwd, chatSessionDir);
    if (existing.length > 0) {
      sessionManager = SessionManager.continueRecent(cwd, chatSessionDir);
      console.log(`[agent] Resuming session for ${groupJid}`);
    } else {
      sessionManager = SessionManager.create(cwd, chatSessionDir);
      console.log(`[agent] New session for ${groupJid}`);
    }
  } catch {
    sessionManager = SessionManager.create(cwd, chatSessionDir);
    console.log(`[agent] New session for ${groupJid} (fresh)`);
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    // SECURITY: No filesystem tools. Only web_search and firecrawl_scrape (from extensions/env).
    tools: [],
  });

  sessions.set(groupJid, session);
  return session;
}

// ── Streaming ──

interface StreamCallbacks {
  onToolStart?: (toolName: string, args: any) => void;
  onToolEnd?: (toolName: string) => void;
  onDelta?: (chunk: string) => void;
}

export async function promptStreaming(
  session: AgentSession,
  text: string,
  callbacks?: StreamCallbacks,
): Promise<{ response: string }> {
  let fullText = "";

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          fullText += delta;
          callbacks?.onDelta?.(delta);
        }
        break;
      case "tool_execution_start":
        console.log(`[agent] Tool start: ${event.toolName}`, JSON.stringify(event.args ?? {}).slice(0, 100));
        callbacks?.onToolStart?.(event.toolName, event.args);
        break;
      case "tool_execution_end":
        console.log(`[agent] Tool end: ${event.toolName}`);
        callbacks?.onToolEnd?.(event.toolName);
        break;
    }
  });

  try {
    await session.prompt(text);
  } finally {
    unsubscribe();
  }

  return { response: fullText };
}

// ── Session management ──

export async function resetGroupSession(jid: string): Promise<void> {
  const session = sessions.get(jid);
  if (session) {
    session.dispose();
    sessions.delete(jid);
  }
  console.log(`[agent] Session reset for ${jid}`);
}

export function disposeSession(jid: string): void {
  const session = sessions.get(jid);
  if (session) {
    session.dispose();
    sessions.delete(jid);
  }
}

// ── Idle session eviction ──
setInterval(() => {
  const now = Date.now();
  for (const [jid, ts] of lastActivity) {
    if (now - ts > SESSION_TTL_MS) {
      console.log(`[session] Evicting idle session for ${jid}`);
      disposeSession(jid);
      lastActivity.delete(jid);
    }
  }
}, 10 * 60 * 1000);
