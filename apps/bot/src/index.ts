/**
 * Echo Discord Bot — Entry Point
 *
 * Responsibilities:
 *  1. Connect to Discord gateway and register slash commands.
 *  2. Open a Socket.IO connection to the Echo backend to receive AI summaries.
 *  3. Post interactive notifications ("Sync Local Env" button) to the configured channel.
 *  4. Relay user approvals back to the backend via WebSocket.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { registerEvents } from './events/registry';
import { BackendClient } from './services/backend-client';

// ── Discord Client ──────────────────────────────────────────────────────────

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Backend WebSocket Client ────────────────────────────────────────────────

export const backendClient = new BackendClient({
  url: process.env.BACKEND_URL ?? 'http://localhost:8000',
  token: process.env.BOT_INTERNAL_TOKEN ?? '',
  workspace: process.env.WORKSPACE ?? 'default',
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  registerEvents(discordClient);

  await discordClient.login(process.env.DISCORD_TOKEN);
  console.log('[bot] Discord client logged in.');

  // Wire the Discord client into the backend client so it can post messages
  backendClient.setDiscordClient(discordClient);
  backendClient.connect();
  console.log('[bot] Backend WebSocket connecting...');
}

main().catch((err) => {
  console.error('[bot] Fatal error:', err);
  process.exit(1);
});
