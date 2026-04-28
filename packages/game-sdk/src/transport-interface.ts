/**
 * ITransport — abstract transport interface.
 *
 * Both PostMessageTransport (production, iframe-based) and
 * MemoryTransport (devMode, same-window) implement this contract.
 * CasinoGameSDK depends only on ITransport, making the transport
 * layer swappable.
 */

import type { BridgeMessageType, GuestMessageType, HostMessageType } from './protocol';

export type MessageHandler<T = unknown> = (payload: T, id?: string) => void;

export interface ITransport {
  /** Send a fire-and-forget message */
  send<T>(type: GuestMessageType, payload: T, id?: string): void;

  /**
   * Send a request and wait for a correlated response.
   * Rejects on timeout or if the transport is destroyed.
   */
  request<TReq, TRes>(
    requestType: GuestMessageType,
    responseType: HostMessageType,
    payload: TReq,
    timeout?: number,
  ): Promise<TRes>;

  /** Subscribe to incoming messages of a given type */
  on<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void;

  /** Unsubscribe a previously subscribed handler */
  off<T = unknown>(type: BridgeMessageType, handler: MessageHandler<T>): void;

  /** Tear down the transport. Rejects all pending requests. */
  destroy(): void;

  /** Whether the transport has been destroyed */
  readonly isDestroyed: boolean;

  /** Default timeout for request-response calls (ms) */
  readonly defaultTimeout: number;
}
