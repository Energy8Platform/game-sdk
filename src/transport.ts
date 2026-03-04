/**
 * PostMessage Transport Layer
 *
 * Handles low-level communication between an iframe (Guest) and its parent (Host)
 * via window.postMessage. Provides request-response correlation with timeouts.
 */

import {
  BridgeMessage,
  BridgeMessageType,
  GuestMessageType,
  HostMessageType,
  createMessage,
  isBridgeMessage,
} from './protocol';
import { TimeoutError, BridgeDestroyedError } from './errors';

type MessageHandler<T = unknown> = (payload: T, id?: string) => void;

export interface TransportOptions {
  /**
   * The expected origin of the parent window.
   * Defaults to `document.referrer` origin. Set explicitly for stricter security.
   * Use `'*'` only in development.
   */
  parentOrigin?: string;

  /** Default timeout for request-response calls (ms). Default: 15000 */
  timeout?: number;

  /**
   * Enable debug logging of all sent and received messages.
   * Logs format: [GUEST -> HOST] / [HOST -> GUEST] MessageType payload
   */
  debug?: boolean;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PostMessageTransport {
  private readonly parentOrigin: string;
  private readonly defaultTimeout: number;
  private readonly handlers = new Map<BridgeMessageType, MessageHandler[]>();
  private readonly pending = new Map<string, PendingRequest>();
  private destroyed = false;
  private readonly debugMode: boolean;

  constructor(options: TransportOptions = {}) {
    this.parentOrigin = options.parentOrigin || this.resolveParentOrigin();
    this.defaultTimeout = options.timeout ?? 15_000;
    this.debugMode = options.debug ?? false;

    this.handleMessage = this.handleMessage.bind(this);
    window.addEventListener('message', this.handleMessage);
  }

  // ─── Public API ──────────────────────────────────────────────────

  /** Send a fire-and-forget message to the parent window */
  send<T>(type: GuestMessageType, payload: T, id?: string): void {
    this.assertNotDestroyed();
    const msg = createMessage(type, payload, id);
    this.log('out', type, payload, id);
    window.parent.postMessage(msg, this.parentOrigin);
  }

  /**
   * Send a request and wait for a correlated response.
   * Returns a Promise that resolves with the response payload,
   * or rejects on timeout / error response.
   */
  request<TReq, TRes>(
    requestType: GuestMessageType,
    responseType: HostMessageType,
    payload: TReq,
    timeout?: number,
  ): Promise<TRes> {
    this.assertNotDestroyed();

    const id = this.uuid();
    const timeoutMs = timeout ?? this.defaultTimeout;

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(requestType, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (payload: unknown) => void,
        reject,
        timer,
      });

      this.send(requestType, payload, id);
    });
  }

  /** Subscribe to incoming messages of a given type */
  on<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler as MessageHandler);
  }

  /** Unsubscribe a previously subscribed handler */
  off<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== handler),
      );
    }
  }

  /** Tear down the transport. Rejects all pending requests. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    window.removeEventListener('message', this.handleMessage);

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeDestroyedError());
      this.pending.delete(id);
    }

    this.handlers.clear();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ─── Private ─────────────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    // Origin check
    if (this.parentOrigin !== '*' && event.origin !== this.parentOrigin) {
      return;
    }

    if (!isBridgeMessage(event.data)) {
      return;
    }

    const msg = event.data as BridgeMessage;
    this.log('in', msg.type, msg.payload, msg.id);

    // Check if this is a response to a pending request
    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg.payload);
      // Still notify handlers so they can observe all messages
    }

    // Dispatch to registered handlers
    const list = this.handlers.get(msg.type);
    if (list) {
      for (const handler of list) {
        try {
          handler(msg.payload, msg.id);
        } catch (err) {
          console.error(`[CasinoSDK] Handler error for "${msg.type}":`, err);
        }
      }
    }
  }

  private resolveParentOrigin(): string {
    try {
      if (typeof document !== 'undefined' && document.referrer) {
        const url = new URL(document.referrer);
        return url.origin;
      }
    } catch {
      // ignore
    }
    // Fallback: same origin
    return typeof window !== 'undefined' ? window.location.origin : '*';
  }

  private uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback for older environments
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new BridgeDestroyedError();
    }
  }

  private log(direction: 'in' | 'out', type: BridgeMessageType, payload: unknown, id?: string): void {
    if (!this.debugMode) return;
    const arrow = direction === 'out' ? '[GUEST -> HOST]' : '[HOST -> GUEST]';
    const idStr = id ? ` (id: ${id})` : '';
    console.debug(`%c${arrow}%c ${type}${idStr}`, 'color: #7c3aed; font-weight: bold', 'color: inherit', payload);
  }
}
