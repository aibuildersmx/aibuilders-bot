/**
 * Tiny contact store: phone → display name (from WhatsApp pushName).
 * Persisted as a single JSON file so context injection can address users by name.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

interface Contact {
  name?: string;
  firstSeen: string;
  lastSeen: string;
  jids: string[];
}

type ContactMap = Record<string, Contact>;

const CONTACTS_FILE = process.env.CONTACTS_FILE ?? "/data/contacts.json";

let cache: ContactMap | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

function load(): ContactMap {
  if (cache) return cache;
  try {
    if (existsSync(CONTACTS_FILE)) {
      cache = JSON.parse(readFileSync(CONTACTS_FILE, "utf-8")) as ContactMap;
    } else {
      cache = {};
    }
  } catch (err) {
    console.error("[contacts] Failed to read store, starting fresh:", err);
    cache = {};
  }
  return cache;
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty || !cache) return;
    try {
      const dir = dirname(CONTACTS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CONTACTS_FILE, JSON.stringify(cache, null, 2));
      dirty = false;
    } catch (err) {
      console.error("[contacts] Failed to write store:", err);
    }
  }, 2000);
}

/**
 * Upsert a contact from an observed message.
 * `senderId` may be a raw JID ("5215512345678@s.whatsapp.net") — only the phone is kept.
 */
export function upsertContact(senderId: string, pushName?: string | null, groupJid?: string): void {
  const phone = senderId.split("@")[0];
  if (!phone) return;
  const store = load();
  const now = new Date().toISOString();
  const existing = store[phone];
  const cleanName = pushName?.trim() || undefined;

  if (!existing) {
    store[phone] = {
      name: cleanName,
      firstSeen: now,
      lastSeen: now,
      jids: groupJid ? [groupJid] : [],
    };
  } else {
    if (cleanName) existing.name = cleanName;
    existing.lastSeen = now;
    if (groupJid && !existing.jids.includes(groupJid)) existing.jids.push(groupJid);
  }
  scheduleFlush();
}

export function getContactName(senderId: string): string | undefined {
  const phone = senderId.split("@")[0];
  return load()[phone]?.name;
}

/**
 * Render a short human label: "Name (…1234)" if name known, else "…1234".
 */
export function getContactLabel(senderId: string): string {
  const phone = senderId.split("@")[0];
  const tail = phone.slice(-4);
  const name = load()[phone]?.name;
  return name ? `${name} (…${tail})` : `…${tail}`;
}
