/**
 * Backend WebSocket client for the Discord bot.
 *
 * Listens for 'github_event' messages from the backend and:
 *  1. Posts a formatted Discord embed to the configured channel.
 *  2. Attaches interactive "Sync Local Env" / "Dismiss" buttons.
 */

import { io, type Socket } from 'socket.io-client';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type TextChannel,
} from 'discord.js';

interface BackendClientOptions {
  url: string;
  token: string;
  workspace: string;
}

interface GithubEventPayload {
  event_type: string;
  summary: string;
  raw: Record<string, unknown>;
}

export class BackendClient {
  private socket: Socket | null = null;
  private discordClient: Client | null = null;
  private readonly options: BackendClientOptions;

  constructor(options: BackendClientOptions) {
    this.options = options;
  }

  /** Inject the Discord client after login. */
  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  connect(): void {
    this.socket = io(this.options.url, {
      auth: {
        token: this.options.token,
        workspace: this.options.workspace,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
    });

    this.socket.on('connect', () => {
      console.log(`[bot:ws] Connected to backend (sid=${this.socket?.id})`);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn(`[bot:ws] Disconnected: ${reason}`);
    });

    this.socket.on('github_event', (payload: GithubEventPayload) => {
      void this.handleGithubEvent(payload);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[bot:ws] Connection error:', err.message);
    });
  }

  sendApproval(actionId: string): void {
    this.socket?.emit('approval_response', {
      action_id: actionId,
      success: true,
      output: 'Approved via Discord button',
    });
  }

  private async handleGithubEvent(payload: GithubEventPayload): Promise<void> {
    const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;
    if (!channelId || !this.discordClient) return;

    const channel = this.discordClient.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) return;

    const actionId = `auto-${Date.now()}`;

    const embed = new EmbedBuilder()
      .setTitle(`🔔 GitHub Event: ${payload.event_type}`)
      .setDescription(payload.summary)
      .setColor(0x5865f2)
      .setTimestamp();

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

    await channel.send({ embeds: [embed], components: [row] });
  }
}
