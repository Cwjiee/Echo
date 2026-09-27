/**
 * EchoWebSocketClient
 *
 * Manages the Socket.IO connection from the Electron main process
 * to the Echo backend server.
 *
 * Emits typed local events:
 *  - 'connected'
 *  - 'disconnected' (reason: string)
 *  - 'approved_resolution' → ApplyRequest
 */

import { EventEmitter } from 'events';
import { io, type Socket } from 'socket.io-client';
import type { ApplyRequest } from '@echo/local-executor';

interface WebSocketClientOptions {
  url: string;
  token: string;
  workspace: string;
}

export class EchoWebSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private readonly options: WebSocketClientOptions;

  constructor(options: WebSocketClientOptions) {
    super();
    this.options = options;
  }

  connect(): void {
    this.socket = io(this.options.url, {
      auth: {
        token: this.options.token,
        workspace: this.options.workspace,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      console.log('[mac-agent:ws] Connected, sid=', this.socket?.id);
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason: string) => {
      console.warn('[mac-agent:ws] Disconnected:', reason);
      this.emit('disconnected', reason);
    });

    this.socket.on('approved_resolution', (payload: ApplyRequest) => {
      console.log('[mac-agent:ws] Received approved_resolution:', payload);
      this.emit('approved_resolution', payload);
    });

    this.socket.on('connect_error', (err: Error) => {
      console.error('[mac-agent:ws] Connection error:', err.message);
    });
  }

  sendApprovalResponse(
    actionId: string,
    results: Array<{ action: string; success: boolean; stdout: string }>,
  ): void {
    this.socket?.emit('approval_response', {
      action_id: actionId,
      success: results.every((r) => r.success),
      output: results.map((r) => `[${r.action}] ${r.stdout}`).join('\n'),
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
