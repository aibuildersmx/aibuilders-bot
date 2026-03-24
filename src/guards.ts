/**
 * Guards — rate limiting, allowlists, cooldowns.
 * All the guardrails to keep the bot safe in a public group.
 */

// ── Group allowlist ──
const allowedGroups = new Set(
  (process.env.ALLOWED_GROUPS ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
);

export function isGroupAllowed(jid: string): boolean {
  // If no groups configured, deny all (safe default)
  if (allowedGroups.size === 0) return false;
  return allowedGroups.has(jid);
}

// ── User allowlist ──
const allowedUsers = new Set(
  (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
);

export function isAllowed(userId: string): boolean {
  // Empty allowlist = everyone can use it
  if (allowedUsers.size === 0) return true;
  return allowedUsers.has(userId);
}

// ── Open groups (anyone can use the bot) ──
const openGroups = new Set(
  (process.env.OPEN_GROUPS ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
);

export function isOpenGroup(jid: string): boolean {
  return openGroups.has(jid);
}

// ── Admin users ──
const adminUsers = new Set(
  (process.env.ADMIN_USERS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
);

export function isAdmin(userId: string): boolean {
  return adminUsers.has(userId);
}

// ── Rate limiting ──
// Per-user sliding window: max N messages per window
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "3600000", 10); // 1 hour
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "10", 10);

const userMessages = new Map<string, number[]>();

export function trackMessage(userId: string): boolean {
  const now = Date.now();
  const timestamps = userMessages.get(userId) ?? [];

  // Remove expired timestamps
  const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (valid.length >= RATE_LIMIT_MAX) {
    return false; // Rate limited
  }

  valid.push(now);
  userMessages.set(userId, valid);
  return true;
}

// ── Cooldown per group ──
// Minimum time between bot responses in a group (avoid spam floods)
const GROUP_COOLDOWN_MS = parseInt(process.env.GROUP_COOLDOWN_MS ?? "5000", 10); // 5 seconds

const lastGroupResponse = new Map<string, number>();

export function checkGroupCooldown(jid: string): boolean {
  const now = Date.now();
  const last = lastGroupResponse.get(jid) ?? 0;

  if (now - last < GROUP_COOLDOWN_MS) return false;

  lastGroupResponse.set(jid, now);
  return true;
}

// ── Cleanup (run periodically) ──
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of userMessages) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) userMessages.delete(userId);
    else userMessages.set(userId, valid);
  }
}, 10 * 60 * 1000); // Every 10 min
