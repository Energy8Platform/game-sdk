/**
 * Minimal Stake RGS client.
 *
 * Inlined here (rather than depending on the public `stake-engine` package)
 * so the SDK keeps zero runtime dependencies and we can shape the client
 * to our needs — typed responses, retry rules, structured errors,
 * connection-state callbacks.
 *
 * Endpoints implemented:
 *   POST /wallet/authenticate                      (idempotent — retried)
 *   POST /wallet/balance                           (idempotent — retried)
 *   POST /wallet/play                              (NOT idempotent — never retried)
 *   POST /wallet/end-round                         (idempotent — retried)
 *   POST /bet/event                                (idempotent — retried)
 *   GET  /bet/replay/{game}/{version}/{mode}/{event}   (idempotent — retried)
 *
 * See: https://stake-engine.com/docs/rgs
 */

import type { ConnectionStatePayload } from '@energy8platform/game-sdk/protocol';
import type { StakeRound, StakeUrlParams } from './types';

/** RGS uses 1_000_000 minor units per major currency unit. */
export const API_MULTIPLIER = 1_000_000;

export interface RGSBalance {
  amount: number;
  currency: string;
}

export interface RGSAuthenticateResponse<TBook = unknown> {
  balance: RGSBalance;
  round: StakeRound<TBook> | null;
  config: {
    gameID: string;
    minBet: number;
    maxBet: number;
    stepBet: number;
    defaultBetLevel: number;
    betLevels: number[];
    betModes?: Record<string, unknown>;
    jurisdiction?: Record<string, unknown>;
  };
  meta?: unknown;
}

export interface RGSPlayParams {
  mode: string;
  /** Amount in minor units (already multiplied by API_MULTIPLIER). */
  amount: number;
}

export interface RGSPlayResponse<TBook = unknown> {
  balance: RGSBalance;
  round: StakeRound<TBook>;
}

export interface RGSEndRoundResponse {
  balance: RGSBalance;
}

export interface RGSEventResponse {
  event: string;
}

export interface RGSReplayParams {
  game: string;
  version: string;
  mode: string;
  event: string;
}

/**
 * Replay endpoint response. The exact shape isn't formally documented;
 * we pass the body straight through and let the bridge / adapter
 * extract the book.
 */
export interface RGSReplayResponse<TBook = unknown> {
  /** Some deployments return the book directly, others wrap it in `state`. */
  state?: TBook;
  /** Optional payout multiplier returned alongside the book. */
  payoutMultiplier?: number;
  /** Optional cost multiplier. */
  costMultiplier?: number;
  /** Bet mode the replay was recorded for. */
  mode?: string;
  /** Original bet amount in minor units, if known. */
  amount?: number;
}

export class RGSError extends Error {
  public readonly status: number;
  public readonly code: string;
  /** Whether this error came from a retryable class of failure. */
  public readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'RGSError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    Object.setPrototypeOf(this, RGSError.prototype);
  }
}

export interface RGSClientOptions {
  url: StakeUrlParams;
  protocol?: 'http' | 'https';
  fetch?: typeof fetch;
  /**
   * Invoked whenever the client detects a connection state change
   * (network blip recovered after retries, all retries exhausted, …).
   *
   * The bridge wires this through to the SDK's `connectionStateChanged`
   * event so the game can render a reconnect overlay.
   */
  onConnectionState?: (state: ConnectionStatePayload) => void;
  /**
   * Retry policy for idempotent requests. Defaults: 3 attempts,
   * exponential backoff 200/600/1800 ms with ±25% jitter.
   */
  retry?: RetryPolicy;
  /**
   * Sleep function used between retries. Default: `setTimeout`-based.
   * Override in tests for deterministic timing.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryPolicy {
  attempts?: number;
  initialDelayMs?: number;
  /** Multiplier applied to delay each retry. Default: 3. */
  factor?: number;
  /** Random jitter as a fraction (0..1). Default: 0.25 (±25%). */
  jitter?: number;
}

const DEFAULT_RETRY: Required<RetryPolicy> = {
  attempts: 3,
  initialDelayMs: 200,
  factor: 3,
  jitter: 0.25,
};

/**
 * Parse Stake URL parameters. Recognises three flavours:
 *
 * - **Live wallet:** `?sessionID=…&rgs_url=…&lang=…&currency=…&device=…&social=…&demo=…`
 *   (per https://stake-engine.com/docs/reference/url-structure)
 * - **Replay:** `?replay=true&game=…&version=…&mode=…&event=…&rgs_url=…`
 *   plus optional `currency`, `amount`, `lang`, `device`, `social`.
 *   (per https://stake-engine.com/docs/api/bet-replay)
 * - Any of the above with `?social=true` and/or `?demo=true`.
 *
 * Throws if `rgs_url` is missing, or if neither `sessionID` nor a
 * complete replay set (`game`/`version`/`mode`/`event`) is provided.
 */
export function parseStakeUrl(input: string | URL | Location): StakeUrlParams {
  const href =
    typeof input === 'string'
      ? input
      : 'href' in input
      ? input.href
      : String(input);
  const url = new URL(href);
  const params = url.searchParams;

  const rgsUrl = params.get('rgs_url');
  if (!rgsUrl) {
    throw new Error('StakeBridge: "rgs_url" missing from URL parameters');
  }

  const device = params.get('device') ?? 'desktop';
  if (device !== 'desktop' && device !== 'mobile') {
    throw new Error(`StakeBridge: unsupported device type "${device}"`);
  }

  const lang = params.get('lang') ?? 'en';
  const social = params.get('social') === 'true';
  const demo = params.get('demo') === 'true';
  const currency = params.get('currency') ?? undefined;

  const replayFlag = params.get('replay') === 'true';
  if (replayFlag) {
    // Per the spec only game/version/mode/event are required for replay.
    // currency/amount/lang/device/social are optional.
    const required = ['game', 'version', 'mode', 'event'] as const;
    for (const key of required) {
      if (!params.get(key)) {
        throw new Error(
          `StakeBridge replay: "${key}" missing from URL parameters`,
        );
      }
    }

    const rawAmount = params.get('amount');
    const amount = rawAmount != null ? Number(rawAmount) : 0;
    if (!Number.isFinite(amount)) {
      throw new Error('StakeBridge replay: "amount" must be numeric');
    }

    return {
      rgsUrl,
      lang,
      device,
      social,
      demo,
      currency,
      replay: {
        game: params.get('game')!,
        version: params.get('version')!,
        mode: params.get('mode')!,
        event: params.get('event')!,
        currency: currency ?? 'USD',
        amount,
      },
    };
  }

  const sessionID = params.get('sessionID');
  if (!sessionID) {
    throw new Error(
      'StakeBridge: "sessionID" missing — pass it for a live session, or use `?replay=true&...` for a replay launch',
    );
  }

  return {
    rgsUrl,
    lang,
    device,
    social,
    demo,
    currency,
    sessionID,
  };
}

interface RequestOptions {
  /** Whether the request is safe to retry. Defaults to `false`. */
  retry?: boolean;
}

export class RGSClient {
  private readonly base: string;
  /** Live wallet session ID. `undefined` in replay launches. */
  private readonly sessionID: string | undefined;
  private readonly lang: string;
  private readonly fetchFn: typeof fetch;
  private readonly onConnectionState?: (state: ConnectionStatePayload) => void;
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Tracks whether the last request succeeded — drives `restored` events. */
  private healthy = true;
  /** Set to true once we've ever had a successful round-trip. */
  private hasEverConnected = false;

  constructor(options: RGSClientOptions) {
    this.sessionID = options.url.sessionID;
    this.lang = options.url.lang;
    const proto = options.protocol ?? 'https';
    this.base = `${proto}://${options.url.rgsUrl}`;
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.onConnectionState = options.onConnectionState;
    this.retryPolicy = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  authenticate<TBook = unknown>(): Promise<RGSAuthenticateResponse<TBook>> {
    return this.post<RGSAuthenticateResponse<TBook>>(
      '/wallet/authenticate',
      { sessionID: this.requireSession(), language: this.lang },
      { retry: true },
    );
  }

  balance(): Promise<{ balance: RGSBalance }> {
    return this.post(
      '/wallet/balance',
      { sessionID: this.requireSession() },
      { retry: true },
    );
  }

  /**
   * IMPORTANT: Play is **not** idempotent — never retried. A timed-out
   * `/wallet/play` may have been processed server-side; the safe
   * recovery is to re-authenticate and check `round` instead of
   * blindly reissuing the bet.
   */
  play<TBook = unknown>(params: RGSPlayParams): Promise<RGSPlayResponse<TBook>> {
    return this.post<RGSPlayResponse<TBook>>(
      '/wallet/play',
      {
        sessionID: this.requireSession(),
        mode: params.mode,
        amount: params.amount,
      },
      { retry: false },
    );
  }

  endRound(): Promise<RGSEndRoundResponse> {
    return this.post<RGSEndRoundResponse>(
      '/wallet/end-round',
      { sessionID: this.requireSession() },
      { retry: true },
    );
  }

  event(eventValue: string): Promise<RGSEventResponse> {
    return this.post<RGSEventResponse>(
      '/bet/event',
      { sessionID: this.requireSession(), event: eventValue },
      { retry: true },
    );
  }

  private requireSession(): string {
    if (!this.sessionID) {
      throw new RGSError(
        0,
        'ERR_NO_SESSION',
        'Wallet endpoint called without a sessionID — this client was launched in replay mode',
        false,
      );
    }
    return this.sessionID;
  }

  replay<TBook = unknown>(
    params: RGSReplayParams,
  ): Promise<RGSReplayResponse<TBook>> {
    const path = `/bet/replay/${encodeURIComponent(params.game)}/${encodeURIComponent(
      params.version,
    )}/${encodeURIComponent(params.mode)}/${encodeURIComponent(params.event)}`;
    return this.get<RGSReplayResponse<TBook>>(path, { retry: true });
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private post<T>(path: string, body: unknown, opts: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  private get<T>(path: string, opts: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const maxAttempts = opts.retry ? this.retryPolicy.attempts : 1;
    let lastError: RGSError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.attempt<T>(method, path, body);
        this.markHealthy();
        return result;
      } catch (err) {
        lastError = err instanceof RGSError ? err : null;
        const retryable = lastError?.retryable === true;
        const hasMoreAttempts = attempt + 1 < maxAttempts;
        if (!retryable || !hasMoreAttempts) {
          this.markUnhealthy(lastError);
          throw err;
        }
        // First failure of a previously-healthy session → notify "lost".
        if (attempt === 0) this.markUnhealthy(lastError);
        const delay = this.delayFor(attempt);
        await this.sleep(delay);
      }
    }
    // Unreachable in practice, but TS wants a return.
    throw lastError ?? new RGSError(0, 'ERR_GEN', 'Unknown error', false);
  }

  private async attempt<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers:
          body !== undefined
            ? { 'Content-Type': 'application/json' }
            : undefined,
      });
    } catch (err) {
      // Network-level failures (DNS, offline, abort) — always retryable.
      throw new RGSError(
        0,
        'ERR_NET',
        `Network error calling ${path}: ${String(err)}`,
        true,
      );
    }

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // ignore non-JSON body
    }

    if (!response.ok) {
      const code =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error: unknown }).error)
          : `ERR_HTTP_${response.status}`;
      const message =
        typeof data === 'object' && data && 'message' in data
          ? String((data as { message: unknown }).message)
          : response.statusText;
      // Retry only on server errors (5xx) and 408. 4xx are client mistakes.
      const retryable = response.status >= 500 || response.status === 408;
      throw new RGSError(response.status, code, message, retryable);
    }

    return data as T;
  }

  private delayFor(attemptIndex: number): number {
    const base =
      this.retryPolicy.initialDelayMs *
      Math.pow(this.retryPolicy.factor, attemptIndex);
    const jitter = this.retryPolicy.jitter;
    const delta = base * jitter * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + delta));
  }

  private markHealthy(): void {
    if (!this.hasEverConnected) {
      this.hasEverConnected = true;
      this.healthy = true;
      return;
    }
    if (!this.healthy) {
      this.healthy = true;
      this.onConnectionState?.({ status: 'restored' });
    }
  }

  private markUnhealthy(err: RGSError | null): void {
    if (this.healthy) {
      this.healthy = false;
      this.onConnectionState?.({
        status: 'lost',
        code: err?.code,
        message: err?.message,
      });
    }
  }
}
