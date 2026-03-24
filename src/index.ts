/**
 * aibuilders-bot — WhatsApp group bot for AI Builders MX
 * Powered by Baileys + Pi SDK 🤖
 */

import "dotenv/config";
import { connectWhatsApp } from "./whatsapp.js";
import { startHealthServer } from "./api.js";
import { refreshAuth } from "./agent.js";

console.log("🤖 AI Builders Bot starting...");

// Health check for Railway
const port = parseInt(process.env.PORT ?? "3000", 10);
startHealthServer(port);

// Proactive token refresh — every 6h
refreshAuth();
setInterval(refreshAuth, 6 * 60 * 60 * 1000);

// Connect to WhatsApp
connectWhatsApp().catch((err) => {
  console.error("[wa] Fatal connection error:", err);
  process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n🤖 Shutting down...");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
