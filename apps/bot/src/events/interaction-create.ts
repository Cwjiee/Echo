/**
 * Handles Discord interactions:
 *  - Slash commands (/sync)
 *  - Button clicks ("Sync Local Env" / "Dismiss")
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
} from 'discord.js';
import { backendClient } from '../index';

export async function onInteractionCreate(interaction: Interaction): Promise<void> {
  // ── Slash Commands ──────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'sync') {
      await handleSyncCommand(interaction);
    }
  }

  // ── Button Interactions ─────────────────────────────────────────────────
  if (interaction.isButton()) {
    const [action, actionId] = interaction.customId.split(':');

    if (action === 'approve_sync') {
      await interaction.deferUpdate();
      backendClient.sendApproval(actionId!);
      await interaction.editReply({
        content: `✅ Sync approved! Your local agent is executing the changes...`,
        components: [],
      });
    }

    if (action === 'dismiss_sync') {
      await interaction.deferUpdate();
      await interaction.editReply({ content: '❌ Sync dismissed.', components: [] });
    }
  }
}

async function handleSyncCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const actionId = `manual-${Date.now()}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_sync:${actionId}`)
      .setLabel('✅ Sync Local Env')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dismiss_sync:${actionId}`)
      .setLabel('❌ Dismiss')
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({
    content: '🔄 Manual sync requested. Approve to execute on your local machine:',
    components: [row],
  });
}
