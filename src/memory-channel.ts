/**
 * MemoryChannel — in-memory communication channel for devMode.
 *
 * Replaces window.postMessage when the game runs outside an iframe
 * (e.g. game engine sandbox / local dev). Both CasinoGameSDK (guest)
 * and Bridge (host) connect to the same shared channel.
 *
 * Messages are dispatched asynchronously via queueMicrotask to emulate
 * the async nature of postMessage and avoid subtle ordering bugs.
 *
 * Usage:
 * ```ts
 * // Automatic — SDK and Bridge both use devMode: true
 * const sdk = new CasinoGameSDK({ devMode: true });
 * const bridge = new Bridge({ devMode: true });
 * // They find each other through window.__casinoBridgeChannel
 * ```
 */

import type { BridgeMessageType, BridgeMessage } from './protocol';
import { createMessage } from './protocol';

type ChannelMessageHandler = (message: BridgeMessage) => void;

declare global {
  interface Window {
    __casinoBridgeChannel?: MemoryChannel;
  }
}

export class MemoryChannel {
  private guestHandlers: ChannelMessageHandler[] = [];
  private hostHandlers: ChannelMessageHandler[] = [];
  private _destroyed = false;
  private readonly debugMode: boolean;

  constructor(options?: { debug?: boolean }) {
    this.debugMode = options?.debug ?? false;
  }

  // ─── Static Global Singleton ───────────────────────────────────

  /**
   * Get (or create) the global shared channel stored on
   * `window.__casinoBridgeChannel`. Both SDK (guest) and Bridge (host)
   * call this to connect to the same channel.
   */
  static getGlobal(options?: { debug?: boolean }): MemoryChannel {
    if (typeof window === 'undefined') {
      throw new Error('MemoryChannel requires a browser environment');
    }
    if (!window.__casinoBridgeChannel) {
      window.__casinoBridgeChannel = new MemoryChannel(options);
    }
    return window.__casinoBridgeChannel;
  }

  /** Remove the global singleton (useful for cleanup in tests) */
  static clearGlobal(): void {
    if (typeof window !== 'undefined') {
      const existing = window.__casinoBridgeChannel;
      if (existing) {
        existing.destroy();
      }
      delete window.__casinoBridgeChannel;
    }
  }

  // ─── Subscriptions ─────────────────────────────────────────────

  /** Subscribe to messages destined for the guest side */
  onGuest(handler: ChannelMessageHandler): void {
    this.guestHandlers.push(handler);
  }

  /** Unsubscribe from guest-side messages */
  offGuest(handler: ChannelMessageHandler): void {
    this.guestHandlers = this.guestHandlers.filter((h) => h !== handler);
  }

  /** Subscribe to messages destined for the host side */
  onHost(handler: ChannelMessageHandler): void {
    this.hostHandlers.push(handler);
  }

  /** Unsubscribe from host-side messages */
  offHost(handler: ChannelMessageHandler): void {
    this.hostHandlers = this.hostHandlers.filter((h) => h !== handler);
  }

  // ─── Send ──────────────────────────────────────────────────────

  /**
   * Send a message from guest → host.
   * Dispatches to all hostHandlers asynchronously.
   */
  sendToHost<T>(type: BridgeMessageType, payload: T, id?: string): void {
    if (this._destroyed) return;
    const msg = createMessage(type, payload, id);
    this.log('TO HOST', type, payload, id);
    // Async dispatch to emulate postMessage behavior
    queueMicrotask(() => {
      for (const handler of [...this.hostHandlers]) {
        try {
          handler(msg);
        } catch (err) {
          console.error('bridge [HOST]: Host handler error:', err);
        }
      }
    });
  }

  /**
   * Send a message from host → guest.
   * Dispatches to all guestHandlers asynchronously.
   */
  sendToGuest<T>(type: BridgeMessageType, payload: T, id?: string): void {
    if (this._destroyed) return;
    const msg = createMessage(type, payload, id);
    this.log('FROM HOST', type, payload, id);
    // Async dispatch to emulate postMessage behavior
    queueMicrotask(() => {
      for (const handler of [...this.guestHandlers]) {
        try {
          handler(msg);
        } catch (err) {
          console.error('bridge [HOST]: Guest handler error:', err);
        }
      }
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.guestHandlers = [];
    this.hostHandlers = [];
  }

  get isDestroyed(): boolean {
    return this._destroyed;
  }

  // ─── Private ───────────────────────────────────────────────────

  private log(direction: string, type: BridgeMessageType, payload: unknown, id?: string): void {
    if (!this.debugMode) return;
    const idStr = id ? ` (id: ${id})` : '';
    console.debug(
      `%cbridge [HOST]%c[${direction}] ${type}${idStr}`,
      'color: #f59e0b; font-weight: bold',
      'color: inherit',
      payload,
    );
  }
}
