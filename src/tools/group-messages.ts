/**
 * Tool: get_group_messages
 *
 * Admin-only tool to read logged messages from a specific WhatsApp group.
 * Only wired into sessions where the requester is an admin (see agent.ts).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { cdmxDateString, cdmxDateStringOffset } from "../time.js";
import { getContactLabel } from "../contacts.js";

const MESSAGES_DIR = process.env.MESSAGES_DIR ?? "/data/messages";

function loadGroupNames(): Record<string, string> {
  return Object.fromEntries(
    (process.env.GROUP_NAMES ?? "")
      .split(",")
      .filter(Boolean)
      .map((entry) => {
        const [jid, name] = entry.split(":");
        return [jid.trim(), name.trim()];
      }),
  );
}

function resolveDate(input: string | undefined): string {
  if (!input || input === "today" || input === "hoy") return cdmxDateString();
  if (input === "yesterday" || input === "ayer") return cdmxDateStringOffset(-1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, "today", or "yesterday".`);
}

interface LoggedMessage {
  ts: string;
  sender: string;
  text: string;
  group?: string;
}

function readJsonl(file: string): LoggedMessage[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LoggedMessage];
      } catch {
        return [];
      }
    });
}

function formatMessages(msgs: LoggedMessage[]): string {
  return msgs
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Mexico_City",
      });
      const sender = getContactLabel(m.sender);
      return `[${time}] ${sender}: ${m.text}`;
    })
    .join("\n");
}

export const GROUP_MESSAGES_TOOL: Anthropic.Tool = {
  name: "get_group_messages",
  description:
    "Reads logged messages from a WhatsApp group the bot is in. Use this when the user asks for a summary, report, or analysis of what happened in a specific group. Returns messages in chronological order with [HH:MM] sender: text format. Senders are rendered as 'Name (…1234)' when their WhatsApp pushName is known, falling back to the last 4 digits of their phone. Quote these names directly when attributing ideas, questions, or links in the recap.",
  input_schema: {
    type: "object",
    properties: {
      group: {
        type: "string",
        description:
          'Group alias as configured in GROUP_NAMES env. Use "list" to see available aliases, or "all" to read every group for the given date.',
      },
      date: {
        type: "string",
        description:
          'Date in YYYY-MM-DD format. Also accepts "today" (default), "yesterday", "hoy", "ayer".',
      },
    },
    required: ["group"],
  },
};

export async function runGroupMessages(input: any): Promise<string> {
  const groupNames = loadGroupNames();
  const aliasToJid: Record<string, string> = {};
  for (const [jid, name] of Object.entries(groupNames)) aliasToJid[name] = jid;

  const groupParam = String(input?.group ?? "").trim();
  if (!groupParam) throw new Error('Missing "group" parameter.');

  if (groupParam === "list") {
    const aliases = Object.values(groupNames);
    return aliases.length
      ? `Available group aliases:\n${aliases.map((a) => `- ${a}`).join("\n")}`
      : "No groups configured in GROUP_NAMES env.";
  }

  const date = resolveDate(input?.date);

  if (groupParam === "all") {
    if (!existsSync(MESSAGES_DIR)) return "No messages directory.";
    const files = readdirSync(MESSAGES_DIR).filter(
      (f) => f.startsWith(`${date}_`) && f.endsWith(".jsonl"),
    );
    if (files.length === 0) return `No messages logged for ${date}.`;
    const sections = files.map((f) => {
      const alias = f.slice(date.length + 1, -".jsonl".length);
      const msgs = readJsonl(join(MESSAGES_DIR, f));
      return `=== ${alias} (${msgs.length} messages) ===\n${formatMessages(msgs) || "(empty)"}`;
    });
    return sections.join("\n\n");
  }

  const jid = aliasToJid[groupParam];
  if (!jid) {
    const available = Object.values(groupNames).join(", ") || "(none)";
    throw new Error(`Unknown group alias "${groupParam}". Available: ${available}`);
  }

  const alias = groupNames[jid];
  const files = [
    join(MESSAGES_DIR, `${date}_${alias}.jsonl`),
    join(MESSAGES_DIR, `${date}.jsonl`),
  ];

  const collected: LoggedMessage[] = [];
  for (const f of files) {
    for (const m of readJsonl(f)) {
      if (m.group && m.group !== jid) continue;
      collected.push(m);
    }
  }

  if (collected.length === 0) {
    return `No messages logged for "${groupParam}" on ${date}.`;
  }

  const header = `Messages from "${groupParam}" on ${date} (${collected.length} total):\n`;
  return header + formatMessages(collected);
}
