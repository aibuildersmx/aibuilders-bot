/**
 * Anthropic-backed agent — one JSONL file per WhatsApp JID on the persistent volume.
 * No streaming: we run the tool loop silently and return the final assistant text.
 */

import Anthropic from "@anthropic-ai/sdk";
import { appendFile, readFile, rename, readdir } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { GROUP_MESSAGES_TOOL, runGroupMessages } from "./tools/group-messages.js";

export const MODELS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
} as const;

export type ModelKey = keyof typeof MODELS;

export const MODEL: string = MODELS.opus;

const CONTEXT_TOKEN_CAP = 150_000;
const MAX_OUTPUT_TOKENS = 16_000; // Opus 4.7 adaptive thinking shares this budget with the response
const MAX_TOOL_ITERATIONS = 6;

const SESSIONS_DIR =
  process.env.SESSIONS_DIR ??
  process.env.PI_SESSIONS_DIR ??
  (existsSync("/data") ? "/data/sessions" : join(process.cwd(), "sessions"));

const AGENTS_MD_PATH =
  process.env.AGENTS_MD_PATH ??
  (existsSync("/data/agent/AGENTS.md")
    ? "/data/agent/AGENTS.md"
    : join(process.cwd(), "agent", "AGENTS.md"));

if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

const client = new Anthropic({ apiKey });

export interface AgentContext {
  isAdmin: boolean;
}

interface StoredMessage {
  ts: string;
  role: "user" | "assistant";
  content: string | any[];
  model?: string;
  usage?: { in: number; out: number };
}

function sanitizeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9-]/g, "_");
}

function sessionFile(jid: string): string {
  return join(SESSIONS_DIR, `${sanitizeJid(jid)}.jsonl`);
}

async function loadHistory(jid: string): Promise<StoredMessage[]> {
  const file = sessionFile(jid);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf-8");
  const out: StoredMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupted line
    }
  }
  return out;
}

async function appendMessage(jid: string, msg: StoredMessage): Promise<void> {
  await appendFile(sessionFile(jid), JSON.stringify(msg) + "\n", "utf-8");
}

function estimateTokens(content: StoredMessage["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4);
  let total = 0;
  for (const block of content) {
    if (block.type === "text") total += Math.ceil((block.text ?? "").length / 4);
    else if (block.type === "image") total += 1500;
    else if (block.type === "tool_use")
      total += Math.ceil(JSON.stringify(block.input ?? {}).length / 4) + 20;
    else if (block.type === "tool_result") {
      const c =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
      total += Math.ceil(c.length / 4);
    }
  }
  return total;
}

function historyToMessages(history: StoredMessage[]): Anthropic.MessageParam[] {
  const picked: StoredMessage[] = [];
  let tokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i].content);
    if (tokens + t > CONTEXT_TOKEN_CAP) break;
    tokens += t;
    picked.unshift(history[i]);
  }

  while (picked.length) {
    const first = picked[0];
    if (first.role !== "user") {
      picked.shift();
      continue;
    }
    if (
      Array.isArray(first.content) &&
      first.content.length > 0 &&
      first.content.every((b: any) => b.type === "tool_result")
    ) {
      picked.shift();
      continue;
    }
    break;
  }

  return picked.map((m) => ({ role: m.role, content: m.content as any }));
}

async function getSystemPrompt(): Promise<string> {
  try {
    return await readFile(AGENTS_MD_PATH, "utf-8");
  } catch {
    return "You are Aiby, a helpful community assistant for AI Builders MX.";
  }
}

async function runTool(name: string, input: any): Promise<string> {
  if (name === "get_group_messages") {
    try {
      return await runGroupMessages(input);
    } catch (err) {
      return `error: ${String((err as Error)?.message ?? err)}`;
    }
  }
  return `[unknown tool: ${name}]`;
}

/**
 * Run a full turn against the model (including any tool-use iterations) and
 * return the final plain-text assistant response. No streaming, no callbacks.
 */
export async function prompt(
  jid: string,
  text: string,
  context: AgentContext,
): Promise<string> {
  const history = await loadHistory(jid);

  const userContent: string = text;

  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(history),
    { role: "user", content: userContent },
  ];

  const system = await getSystemPrompt();

  await appendMessage(jid, {
    ts: new Date().toISOString(),
    role: "user",
    content: userContent,
  });

  const tools: Anthropic.Tool[] = context.isAdmin ? [GROUP_MESSAGES_TOOL] : [];

  let finalText = "";
  let totalIn = 0;
  let totalOut = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // Add a cache breakpoint on the last block of the last message so the
    // entire prefix (tools + system + prior messages) stays cached within the
    // 5-min TTL. Cheap on subsequent iterations of the same tool loop and on
    // back-to-back queries in the same session.
    const messagesForSend = messages.map((m, i) => {
      if (i !== messages.length - 1) return m;
      const content = m.content;
      if (typeof content === "string") {
        return {
          role: m.role,
          content: [
            { type: "text", text: content, cache_control: { type: "ephemeral" } },
          ] as any,
        };
      }
      if (Array.isArray(content) && content.length > 0) {
        const newContent = content.map((b, j) =>
          j === content.length - 1 ? { ...b, cache_control: { type: "ephemeral" } } : b,
        );
        return { role: m.role, content: newContent as any };
      }
      return m;
    });

    // Opus 4.7 requires adaptive thinking (manual budget_tokens is rejected).
    // Interleaved thinking between tool calls is enabled automatically in this
    // mode; we already pass assistant blocks back unchanged across iterations.
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      tools: tools.length ? tools : undefined,
      messages: messagesForSend,
    });

    totalIn +=
      (response.usage.input_tokens ?? 0) +
      ((response.usage as any).cache_read_input_tokens ?? 0) +
      ((response.usage as any).cache_creation_input_tokens ?? 0);
    totalOut += response.usage.output_tokens ?? 0;

    const assistantContent = response.content as any[];
    messages.push({ role: "assistant", content: assistantContent });

    // Collect only the final (post-tools) text for the returned response.
    if (response.stop_reason !== "tool_use") {
      let turnText = "";
      for (const block of assistantContent) {
        if (block.type === "text") turnText += block.text;
      }
      finalText = turnText;

      await appendMessage(jid, {
        ts: new Date().toISOString(),
        role: "assistant",
        content: assistantContent,
        model: MODEL,
        usage: { in: totalIn, out: totalOut },
      });
      break;
    }

    // Persist assistant turn with tool_use blocks, then execute tools.
    await appendMessage(jid, {
      ts: new Date().toISOString(),
      role: "assistant",
      content: assistantContent,
      model: MODEL,
    });

    const toolResults: any[] = [];
    for (const block of assistantContent) {
      if (block.type !== "tool_use") continue;
      console.log(
        `[tool] ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 160)}`,
      );
      const output = await runTool(block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }

    messages.push({ role: "user", content: toolResults });
    await appendMessage(jid, {
      ts: new Date().toISOString(),
      role: "user",
      content: toolResults,
    });
  }

  return finalText;
}

/**
 * Archive the current session file with a timestamp suffix (does not delete).
 */
export async function resetSession(jid: string): Promise<void> {
  const file = sessionFile(jid);
  if (!existsSync(file)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(file, join(SESSIONS_DIR, `${sanitizeJid(jid)}.${ts}.jsonl`));
}

export interface SessionStats {
  messages: number;
  tokensApprox: number;
  tokenCap: number;
  lastActivity: Date | null;
  archivedCount: number;
}

export async function getSessionStats(jid: string): Promise<SessionStats> {
  const history = await loadHistory(jid);
  const tokens = history.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  const last = history.length
    ? new Date(history[history.length - 1].ts)
    : null;

  let archivedCount = 0;
  try {
    const files = await readdir(SESSIONS_DIR);
    const safe = sanitizeJid(jid);
    archivedCount = files.filter(
      (f) => f.startsWith(`${safe}.`) && f !== `${safe}.jsonl`,
    ).length;
  } catch {
    // ignore
  }

  return {
    messages: history.length,
    tokensApprox: tokens,
    tokenCap: CONTEXT_TOKEN_CAP,
    lastActivity: last,
    archivedCount,
  };
}
