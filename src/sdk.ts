/**
 * CasinoGameSDK — the main class for game developers.
 *
 * Usage inside an iframe game:
 *
 * ```ts
 * import { CasinoGameSDK } from '@casino-platform/game-sdk';
 *
 * const sdk = new CasinoGameSDK();
 * const { balance, currency, config, session } = await sdk.ready();
 *
 * // Spin
 * const result = await sdk.play({ action: 'spin', bet: 1.0 });
 * console.log(result.data.matrix, result.totalWin);
 *
 * // Free spins (if session started)
 * if (result.session && result.nextActions.includes('free_spin')) {
 *   let done = false;
 *   while (!done) {
 *     const fs = await sdk.play({ action: 'free_spin', bet: 0, roundId: result.roundId });
 *     done = fs.session?.completed ?? true;
 *   }
 * }
 * ```
 */

import { PostMessageTransport } from './transport';
import {
  InitPayload,
  PlayRequestPayload,
  PlayResultPayload,
  PlayResultAckPayload,
  PlayErrorPayload,
  BalanceUpdatePayload,
  StateResponsePayload,
  GameConfigData,
  SessionData,
} from './protocol';
import { SDKError, BridgeNotReadyError } from './errors';
import type {
  CasinoGameSDKOptions,
  InitData,
  PlayParams,
  PlayResultData,
  BalanceData,
} from './types';

type EventMap = {
  balanceUpdate: BalanceData;
  error: SDKError;
};

type EventHandler<K extends keyof EventMap> = (data: EventMap[K]) => void;

export class CasinoGameSDK {
  private transport: PostMessageTransport;
  private initialized = false;
  private readonly debugMode: boolean;

  private _balance = 0;
  private _currency = 'USD';
  private _config: GameConfigData | null = null;
  private _session: SessionData | null = null;

  private eventHandlers: { [K in keyof EventMap]?: EventHandler<K>[] } = {};

  constructor(options?: CasinoGameSDKOptions) {
    this.debugMode = options?.debug ?? false;
    this.transport = new PostMessageTransport({
      parentOrigin: options?.parentOrigin,
      timeout: options?.timeout,
      debug: options?.debug,
    });

    // Listen for unsolicited balance updates from the host
    this.transport.on<BalanceUpdatePayload>('BALANCE_UPDATE', (payload) => {
      this._balance = payload.balance;
      this.emit('balanceUpdate', { balance: payload.balance });
    });

    // Listen for generic errors pushed by the host
    this.transport.on<{ code: string; message: string }>('ERROR', (payload) => {
      this.emit('error', new SDKError(payload.code, payload.message));
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Signal to the host that the game is loaded and ready.
   * Returns initial data: balance, currency, game config, and active session (if any).
   *
   * Must be called once before any other method.
   */
  async ready(): Promise<InitData> {
    this.log('ready() → sending GAME_READY');
    const payload = await this.transport.request<{}, InitPayload>(
      'GAME_READY',
      'INIT',
      {},
    );

    this._balance = payload.balance;
    this._currency = payload.currency;
    this._config = payload.config;
    this._session = payload.session ?? null;
    this.initialized = true;

    this.log(
      `ready() ✓ balance=${payload.balance} ${payload.currency}` +
      (payload.session ? ` session=${payload.session.roundId} (${payload.session.spinsRemaining} remaining)` : ' no session'),
    );

    return {
      balance: payload.balance,
      currency: payload.currency,
      config: payload.config,
      session: payload.session ?? null,
      assetsUrl: payload.assetsUrl,
    };
  }

  /**
   * Destroy the SDK instance. Cleans up event listeners and
   * rejects any pending requests.
   */
  destroy(): void {
    this.log('destroy()');
    this.transport.destroy();
    this.eventHandlers = {};
    this.initialized = false;
  }

  // ─── Game Actions ────────────────────────────────────────────────

  /**
   * Execute a universal game action (spin, free_spin, buy_bonus, pick, etc.).
   *
   * This is the preferred method. It replaces spin() and freeSpin().
   *
   * @throws {SDKError} with code 'INSUFFICIENT_FUNDS', 'ACTIVE_SESSION_EXISTS', etc.
   * @throws {TimeoutError} if the host doesn't respond in time
   */
  async play(params: PlayParams): Promise<PlayResultData> {
    this.assertReady();
    this.log(`play() → action=${params.action} bet=${params.bet}${params.roundId ? ` roundId=${params.roundId}` : ''}`);

    const requestPayload: PlayRequestPayload = {
      action: params.action,
      bet: params.bet,
      roundId: params.roundId,
      params: params.params,
    };

    const id = crypto.randomUUID();

    const result = await new Promise<PlayResultData>((resolve, reject) => {
      const cleanup = () => {
        this.transport.off('PLAY_RESULT', onResult);
        this.transport.off('PLAY_ERROR', onError);
      };

      const timeout = setTimeout(() => {
        cleanup();
        this.log(`play() ✗ TIMEOUT action=${params.action}`);
        reject(new SDKError('TIMEOUT', 'No play response within timeout period'));
      }, (this.transport as any).defaultTimeout ?? 15_000);

      const onResult = (payload: PlayResultPayload, msgId?: string) => {
        if (msgId !== id) return;
        clearTimeout(timeout);
        cleanup();
        this._balance = payload.balanceAfter;
        this.emit('balanceUpdate', { balance: payload.balanceAfter });

        // Update session state
        if (payload.session) {
          this._session = payload.session;
        } else if (payload.session === null) {
          this._session = null;
        }

        this.log(
          `play() ✓ roundId=${payload.roundId} totalWin=${payload.totalWin} balanceAfter=${payload.balanceAfter}` +
          ` nextActions=[${payload.nextActions.join(', ')}]` +
          (payload.session ? ` session=${payload.session.roundId} (${payload.session.spinsRemaining} remaining)` : '') +
          (payload.session === null ? ' session=null' : '') +
          (payload.creditPending ? ' creditPending=true' : ''),
        );

        resolve(payload as PlayResultData);
      };

      const onError = (payload: PlayErrorPayload, msgId?: string) => {
        if (msgId !== id) return;
        clearTimeout(timeout);
        cleanup();
        this.log(`play() ✗ ${payload.code}: ${payload.message}`);
        reject(new SDKError(payload.code, payload.message));
      };

      this.transport.on<PlayResultPayload>('PLAY_RESULT', onResult);
      this.transport.on<PlayErrorPayload>('PLAY_ERROR', onError);
      this.transport.send('PLAY_REQUEST', requestPayload, id);
    });

    return result;
  }

  /**
   * Acknowledge that the game has fully processed a PLAY_RESULT.
   *
   * Call this after animations and state updates are complete so the host
   * knows the client is ready for the next action.
   *
   * @param result - The PlayResultData returned by sdk.play()
   * @param id - Optional correlation ID (pass the same id used in the play call if needed)
   */
  playAck(result: PlayResultData, id?: string): void {
    if (this.transport.isDestroyed || !this.initialized) {
      console.warn('[CasinoSDK] playAck called but SDK is not ready or has been destroyed');
      return;
    }
    this.log(`playAck() → roundId=${result.roundId} action=${result.action} totalWin=${result.totalWin}`);
    const payload: PlayResultAckPayload = {
      roundId: result.roundId,
      action: result.action,
      totalWin: result.totalWin,
      balanceAfter: result.balanceAfter,
    };
    this.transport.send('PLAY_RESULT_ACK', payload, id);
  }

  /**
   * Fetch the current player balance from the host.
   */
  async getBalance(): Promise<BalanceData> {
    this.assertReady();
    this.log('getBalance()');

    const payload = await this.transport.request<{}, BalanceUpdatePayload>(
      'GET_BALANCE',
      'BALANCE_UPDATE',
      {},
    );

    this._balance = payload.balance;
    this.log(`getBalance() ✓ balance=${payload.balance}`);
    return { balance: payload.balance };
  }

  /**
   * Query the host for the active game session (e.g. after page reload).
   * Returns null if no session is active.
   */
  async getState(): Promise<SessionData | null> {
    this.assertReady();
    this.log('getState()');

    const payload = await this.transport.request<{}, StateResponsePayload>(
      'GET_STATE',
      'STATE_RESPONSE',
      {},
    );

    this._session = payload.session;
    this.log(
      payload.session
        ? `getState() ✓ session=${payload.session.roundId} (${payload.session.spinsRemaining} remaining)`
        : 'getState() ✓ no active session',
    );
    return payload.session;
  }

  /**
   * Ask the host to open the deposit / cashier UI.
   * Fire-and-forget — no response expected.
   */
  openDeposit(): void {
    this.log('openDeposit()');
    this.transport.send('OPEN_DEPOSIT', {});
  }

  // ─── Events ──────────────────────────────────────────────────────

  /**
   * Subscribe to SDK events.
   *
   * Available events:
   * - `balanceUpdate` — emitted when the player balance changes
   * - `error` — emitted on unexpected errors pushed by the host
   */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    (this.eventHandlers[event] as EventHandler<K>[]).push(handler);
  }

  /** Unsubscribe from an event */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): void {
    const list = this.eventHandlers[event] as EventHandler<K>[] | undefined;
    if (list) {
      (this.eventHandlers[event] as EventHandler<K>[]) = list.filter(
        (h) => h !== handler,
      );
    }
  }

  // ─── State Getters ───────────────────────────────────────────────

  /** Current player balance */
  get balance(): number {
    return this._balance;
  }

  /** Player currency */
  get currency(): string {
    return this._currency;
  }

  /** Game configuration received during init */
  get config(): GameConfigData | null {
    return this._config;
  }

  /** Active game session (free spins in progress), or null */
  get session(): SessionData | null {
    return this._session;
  }

  // ─── Private ─────────────────────────────────────────────────────

  private log(message: string): void {
    if (!this.debugMode) return;
    console.debug(`%c[SDK]%c ${message}`, 'color: #16a34a; font-weight: bold', 'color: inherit');
  }

  private assertReady(): void {
    if (this.transport.isDestroyed) {
      throw new SDKError('BRIDGE_DESTROYED', 'SDK has been destroyed');
    }
    if (!this.initialized) {
      throw new BridgeNotReadyError();
    }
  }

  private emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const list = this.eventHandlers[event] as EventHandler<K>[] | undefined;
    if (list) {
      for (const handler of list) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[CasinoSDK] Event handler error for "${event}":`, err);
        }
      }
    }
  }
}

// ─── UMD global export ─────────────────────────────────────────────

if (typeof window !== 'undefined') {
  (window as any).CasinoGameSDK = CasinoGameSDK;
}
