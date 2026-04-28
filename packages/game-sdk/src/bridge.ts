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
import { MemoryChannel } from './memory-channel';

// ─── Types ───────────────────────────────────────────────────────────

export type MessageHandler<T = unknown> = (payload: T, id?: string) => void;

export interface BridgeOptions {
  /**
   * The game iframe element to communicate with.
   * Required when devMode is not true.
   */
  iframe?: HTMLIFrameElement;
  /** Target origin for postMessage (default: `'*'`) */
  targetOrigin?: string;
  /**
   * Enable debug logging of all sent and received messages.
   * Logs format: bridge [HOST][FROM HOST] / bridge [HOST][TO HOST] MessageType payload
   */
  debug?: boolean;
  /**
   * Enable dev mode for running without an iframe.
   *
   * When `true`, the Bridge uses an in-memory channel (`MemoryChannel`)
   * instead of `window.postMessage`. The game SDK must also be created
   * with `devMode: true` in the same page — they connect through
   * `window.__casinoBridgeChannel`.
   *
   * @default false
   */
  devMode?: boolean;
}

// ─── Bridge Class ────────────────────────────────────────────────────

export class Bridge {
  private iframe: HTMLIFrameElement | null;
  private targetOrigin: string;
  private handlers: Map<BridgeMessageType, MessageHandler[]>;
  private readonly debugMode: boolean;
  private readonly devMode: boolean;
  private readonly channel: MemoryChannel | null;
  private readonly boundOnChannelMessage: ((msg: BridgeMessage) => void) | null;

  constructor(options: BridgeOptions) {
    this.devMode = options.devMode ?? false;
    this.debugMode = options.debug ?? false;
    this.handlers = new Map();
    this.targetOrigin = options.targetOrigin || '*';

    if (this.devMode) {
      this.iframe = null;
      this.channel = MemoryChannel.getGlobal({ debug: options.debug });
      this.boundOnChannelMessage = (msg: BridgeMessage) => {
        this.log('in', msg.type, msg.payload, msg.id);
        this.dispatch(msg.type, msg.payload, msg.id);
      };
      this.channel.onHost(this.boundOnChannelMessage);
    } else {
      if (!options.iframe) {
        throw new Error('Bridge: iframe option is required when devMode is not enabled');
      }
      this.iframe = options.iframe;
      this.channel = null;
      this.boundOnChannelMessage = null;
      this.onMessage = this.onMessage.bind(this);
      window.addEventListener('message', this.onMessage);
    }
  }

  /** Remove all listeners and clean up */
  public destroy(): void {
    if (this.devMode && this.channel && this.boundOnChannelMessage) {
      this.channel.offHost(this.boundOnChannelMessage);
    } else {
      window.removeEventListener('message', this.onMessage);
    }
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

  /** Send a message to the game iframe (or via memory channel in devMode) */
  public send<T = unknown>(type: BridgeMessageType, payload: T, id?: string): void {
    if (this.devMode && this.channel) {
      this.log('out', type, payload, id);
      this.channel.sendToGuest(type, payload, id);
      return;
    }

    if (!this.iframe?.contentWindow) {
      console.warn('bridge [HOST]: iframe contentWindow is null');
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
    const dir = direction === 'out' ? '[FROM HOST]' : '[TO HOST]';
    const idStr = id ? ` (id: ${id})` : '';
    console.debug(`%cbridge [HOST]%c${dir} ${type}${idStr}`, 'color: #0ea5e9; font-weight: bold', 'color: inherit', payload);
  }
}
