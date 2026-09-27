import type { Client } from 'discord.js';
import { onReady } from './ready';
import { onInteractionCreate } from './interaction-create';

export function registerEvents(client: Client): void {
  client.on('ready', onReady);
  client.on('interactionCreate', onInteractionCreate);
}
