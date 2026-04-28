/**
 * MemoryTransport — guest-side transport for devMode.
 *
 * Implements the same ITransport interface as PostMessageTransport,
 * but communicates through a shared MemoryChannel instead of
 * window.postMessage. This allows the game SDK to work without
 * an iframe in development/sandbox environments.
 */

import type { BridgeMessage, BridgeMessageType, GuestMessageType, HostMessageType } from './protocol';
import type { ITransport, MessageHandler } from './transport-interface';
import { TimeoutError, BridgeDestroyedError } from './errors';
import { MemoryChannel } from './memory-channel';

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MemoryTransportOptions {
  /** Default timeout for request-response calls (ms). Default: 15000 */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export class MemoryTransport implements ITransport {
  private readonly channel: MemoryChannel;
  private readonly handlers = new Map<BridgeMessageType, MessageHandler[]>();
  private readonly pending = new Map<string, PendingRequest>();
  private destroyed = false;
  private readonly debugMode: boolean;
  public readonly defaultTimeout: number;

  private readonly boundHandler: (msg: BridgeMessage) => void;

  constructor(channel: MemoryChannel, options: MemoryTransportOptions = {}) {
    this.channel = channel;
    this.defaultTimeout = options.timeout ?? 15_000;
    this.debugMode = options.debug ?? false;

    // Subscribe to messages coming FROM the host TO the guest
    this.boundHandler = this.handleMessage.bind(this);
    this.channel.onGuest(this.boundHandler);
  }

  // ─── ITransport Implementation ─────────────────────────────────

  send<T>(type: GuestMessageType, payload: T, id?: string): void {
    this.assertNotDestroyed();
    this.log('out', type, payload, id);
    this.channel.sendToHost(type, payload, id);
  }

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

  on<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler as MessageHandler);
  }

  off<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void {
    const list = this.handlers.get(type);
    if (list) {
      this.handlers.set(
        type,
        list.filter((h) => h !== handler),
      );
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.channel.offGuest(this.boundHandler);

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeDestroyedError());
    }
    this.pending.clear();
    this.handlers.clear();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ─── Private ───────────────────────────────────────────────────

  private handleMessage(msg: BridgeMessage): void {
    if (this.destroyed) return;

    this.log('in', msg.type, msg.payload, msg.id);

    // Check if this is a response to a pending request
    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg.payload);
    }

    // Dispatch to registered handlers
    const list = this.handlers.get(msg.type);
    if (list) {
      for (const handler of list) {
        try {
          handler(msg.payload, msg.id);
        } catch (err) {
          console.error(`sdk [GUEST]: Handler error for "${msg.type}":`, err);
        }
      }
    }
  }

  private uuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
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
    const dir = direction === 'out' ? '[FROM GUEST]' : '[TO GUEST]';
    const idStr = id ? ` (id: ${id})` : '';
    console.debug(`%csdk [GUEST]%c${dir} ${type}${idStr}`, 'color: #7c3aed; font-weight: bold', 'color: inherit', payload);
  }
}
