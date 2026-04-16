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
  id?: string;
  sender: string;
  text: string;
  group?: string;
}

interface LoggedReaction {
  ts: string;
  targetId: string;
  reactor: string;
  emoji: string;
}

function readJsonl<T = LoggedMessage>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

/**
 * Collapse reaction events to final state per (targetId, reactor).
 * Last event wins. Empty emoji means the reactor removed it.
 * Returns a map of targetId → array of {emoji, reactor} currently active.
 */
function collapseReactions(events: LoggedReaction[]): Map<string, Array<{ emoji: string; reactor: string }>> {
  const latestByKey = new Map<string, LoggedReaction>();
  for (const ev of events) {
    const key = `${ev.targetId}|${ev.reactor}`;
    const prev = latestByKey.get(key);
    if (!prev || prev.ts < ev.ts) latestByKey.set(key, ev);
  }
  const byTarget = new Map<string, Array<{ emoji: string; reactor: string }>>();
  for (const ev of latestByKey.values()) {
    if (!ev.emoji) continue;
    const list = byTarget.get(ev.targetId) ?? [];
    list.push({ emoji: ev.emoji, reactor: ev.reactor });
    byTarget.set(ev.targetId, list);
  }
  return byTarget;
}

function formatReactions(list: Array<{ emoji: string; reactor: string }> | undefined): string {
  if (!list || list.length === 0) return "";
  const counts = new Map<string, number>();
  for (const r of list) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([emoji, n]) => (n > 1 ? `${emoji}×${n}` : emoji));
  return `  [${parts.join(" ")}]`;
}

function formatMessages(
  msgs: LoggedMessage[],
  reactionsByTarget?: Map<string, Array<{ emoji: string; reactor: string }>>,
): string {
  return msgs
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Mexico_City",
      });
      const sender = getContactLabel(m.sender);
      const reacts = m.id && reactionsByTarget ? formatReactions(reactionsByTarget.get(m.id)) : "";
      return `[${time}] ${sender}: ${m.text}${reacts}`;
    })
    .join("\n");
}

export const GROUP_MESSAGES_TOOL: Anthropic.Tool = {
  name: "get_group_messages",
  description:
    "Reads logged messages from a WhatsApp group the bot is in. Use this when the user asks for a summary, report, or analysis of what happened in a specific group. Returns messages in chronological order with `[HH:MM] sender: text` format. Senders are rendered as 'Name (…1234)' when their WhatsApp pushName is known, falling back to '…1234' (last 4 digits of their phone). Same '…1234' suffix means SAME person — do not split into multiple actors. Messages that received reactions get a trailing `  [emoji×N emoji×N]` block where N is the count (omitted when N=1). Reactions are community attention signal, not truth signal. Inline `[🔗 URL — summary]`, `[📷 description]`, and `[📄 filename — summary]` blocks are system-generated metadata, not words the sender said.",
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
    const allFiles = readdirSync(MESSAGES_DIR);
    const msgFiles = allFiles.filter(
      (f) => f.startsWith(`${date}_`) && f.endsWith(".jsonl") && !f.endsWith("_reactions.jsonl"),
    );
    if (msgFiles.length === 0) return `No messages logged for ${date}.`;
    const anchor = new Date(date + "T00:00:00-06:00");
    const nextDay = cdmxDateStringOffset(1, anchor);
    const sections = msgFiles.map((f) => {
      const alias = f.slice(date.length + 1, -".jsonl".length);
      const msgs = readJsonl(join(MESSAGES_DIR, f));
      const reactionEvents: LoggedReaction[] = [
        ...readJsonl<LoggedReaction>(join(MESSAGES_DIR, `${date}_${alias}_reactions.jsonl`)),
        ...readJsonl<LoggedReaction>(join(MESSAGES_DIR, `${nextDay}_${alias}_reactions.jsonl`)),
      ];
      const reactionsByTarget = collapseReactions(reactionEvents);
      return `=== ${alias} (${msgs.length} messages) ===\n${formatMessages(msgs, reactionsByTarget) || "(empty)"}`;
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

  // Reactions to messages from `date` may land in the same-day file OR later-day
  // files (someone reacts the next morning). Load `date` and the following day.
  const anchor = new Date(date + "T00:00:00-06:00");
  const nextDay = cdmxDateStringOffset(1, anchor);
  const reactionEvents: LoggedReaction[] = [
    ...readJsonl<LoggedReaction>(join(MESSAGES_DIR, `${date}_${alias}_reactions.jsonl`)),
    ...readJsonl<LoggedReaction>(join(MESSAGES_DIR, `${nextDay}_${alias}_reactions.jsonl`)),
  ];
  const reactionsByTarget = collapseReactions(reactionEvents);

  const header = `Messages from "${groupParam}" on ${date} (${collected.length} total):\n`;
  return header + formatMessages(collected, reactionsByTarget);
}
