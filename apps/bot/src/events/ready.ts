import type { Client } from 'discord.js';

export async function onReady(client: Client<true>): Promise<void> {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  // TODO: Register slash commands via REST API on ready
}
