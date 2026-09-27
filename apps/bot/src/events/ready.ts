import { Client, REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Manually trigger a local environment sync')
    .toJSON(),
];

export async function onReady(client: Client<true>): Promise<void> {
  console.log(`[bot] Logged in as ${client.user.tag}`);

  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.warn('[bot] Skipping slash command registration: DISCORD_TOKEN or DISCORD_CLIENT_ID not set');
    return;
  }

  const rest = new REST().setToken(token);

  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('[bot] Slash commands registered.');
  } catch (err) {
    console.error('[bot] Failed to register slash commands:', err);
  }
}
