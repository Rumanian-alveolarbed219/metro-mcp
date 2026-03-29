import WebSocket from 'ws';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('metro-events');

type MetroEventHandler = (event: MetroEvent) => void;

export interface MetroEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Client for Metro's `/events` WebSocket endpoint.
 *
 * This endpoint broadcasts all Metro reporter events (build progress,
 * bundling errors, etc.) with no registration needed — just connect
 * and receive. Independent of the CDP connection.
 */
export class MetroEventsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MetroEventHandler>>();
  private _isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string | null = null;

  connect(host: string, port: number): void {
    this.url = `ws://${host}:${port}/events`;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.url) return;

    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this._isConnected = true;
        logger.info('Connected to Metro events');
      });

      this.ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString()
          : Array.isArray(data) ? Buffer.concat(data).toString()
          : Buffer.from(data).toString();

        try {
          const event = JSON.parse(text) as MetroEvent;
          if (event.type) {
            this.emit(event.type, event);
          }
        } catch {
          logger.debug('Failed to parse Metro event');
        }
      });

      this.ws.on('close', () => {
        this._isConnected = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', () => {
        if (!this._isConnected) {
          this.scheduleReconnect();
        }
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, 5000);
  }

  on(event: string, handler: MetroEventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: MetroEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }
    this._isConnected = false;
  }

  private emit(type: string, event: MetroEvent): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          logger.error(`Error in event handler for ${type}:`, err);
        }
      }
    }
  }
}
