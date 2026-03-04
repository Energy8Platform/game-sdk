/**
 * Host-side Bridge
 *
 * Sends and receives __casino_bridge envelope messages to/from
 * the game iframe (which uses the guest-side CasinoGameSDK).
 *
 * Usage:
 * ```ts
 * import { Bridge } from '@energy8platform/game-sdk';
 *
 * const bridge = new Bridge({ iframe: document.getElementById('game') as HTMLIFrameElement });
 * bridge.on('GAME_READY', () => bridge.send('INIT', { balance: 100, currency: 'USD', config }));
 * ```
 */
import {
  type BridgeMessage,
  type BridgeMessageType,
  isBridgeMessage,
  createMessage,
} from './protocol';

// ─── Types ───────────────────────────────────────────────────────────

export type MessageHandler<T = unknown> = (payload: T, id?: string) => void;

export interface BridgeOptions {
  /** The game iframe element to communicate with */
  iframe: HTMLIFrameElement;
  /** Target origin for postMessage (default: `'*'`) */
  targetOrigin?: string;
  /**
   * Enable debug logging of all sent and received messages.
   * Logs format: [HOST -> GUEST] / [GUEST -> HOST] MessageType payload
   */
  debug?: boolean;
}

// ─── Bridge Class ────────────────────────────────────────────────────

export class Bridge {
  private iframe: HTMLIFrameElement;
  private targetOrigin: string;
  private handlers: Map<BridgeMessageType, MessageHandler[]>;
  private readonly debugMode: boolean;

  constructor(options: BridgeOptions) {
    this.iframe = options.iframe;
    this.targetOrigin = options.targetOrigin || '*';
    this.handlers = new Map();
    this.debugMode = options.debug ?? false;

    this.onMessage = this.onMessage.bind(this);
    window.addEventListener('message', this.onMessage);
  }

  /** Remove all listeners and clean up */
  public destroy(): void {
    window.removeEventListener('message', this.onMessage);
    this.handlers.clear();
  }

  /** Subscribe to a specific message type from the game */
  public on<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler as MessageHandler);
  }

  /** Unsubscribe a handler */
  public off<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      this.handlers.set(
        type,
        handlers.filter((h) => h !== handler),
      );
    }
  }

  /** Send a message to the game iframe */
  public send<T = unknown>(type: BridgeMessageType, payload: T, id?: string): void {
    if (!this.iframe.contentWindow) {
      console.warn('Bridge: iframe contentWindow is null');
      return;
    }
    const message: BridgeMessage<T> = createMessage(type, payload, id);
    this.log('out', type, payload, id);
    this.iframe.contentWindow.postMessage(message, this.targetOrigin);
  }

  private onMessage(event: MessageEvent): void {
    if (isBridgeMessage(event.data)) {
      this.log('in', event.data.type, event.data.payload, event.data.id);
      this.dispatch(event.data.type, event.data.payload, event.data.id);
    }
  }

  private dispatch(type: BridgeMessageType, payload: unknown, id?: string): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.forEach((handler) => handler(payload, id));
    }
  }

  private log(direction: 'in' | 'out', type: BridgeMessageType, payload: unknown, id?: string): void {
    if (!this.debugMode) return;
    const arrow = direction === 'out' ? '[HOST -> GUEST]' : '[GUEST -> HOST]';
    const idStr = id ? ` (id: ${id})` : '';
    console.debug(`%c${arrow}%c ${type}${idStr}`, 'color: #0ea5e9; font-weight: bold', 'color: inherit', payload);
  }
}
