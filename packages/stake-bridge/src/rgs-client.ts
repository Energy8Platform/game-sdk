/**
 * Minimal Stake RGS client.
 *
 * Inlined here (rather than depending on the public `stake-engine` package)
 * so the SDK keeps zero runtime dependencies and we can shape the client
 * to our needs — typed responses, single-flight calls, structured errors.
 *
 * Endpoints implemented:
 *   POST /wallet/authenticate
 *   POST /wallet/balance
 *   POST /wallet/play
 *   POST /wallet/end-round
 *   POST /bet/event
 *
 * See: https://stake-engine.com/docs/rgs
 */

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

export class RGSError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RGSError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, RGSError.prototype);
  }
}

export interface RGSClientOptions {
  url: StakeUrlParams;
  protocol?: 'http' | 'https';
  fetch?: typeof fetch;
}

/**
 * Parse Stake URL parameters from a Location-like value.
 * Throws if `sessionID` or `rgs_url` is missing.
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

  const sessionID = params.get('sessionID');
  if (!sessionID) {
    throw new Error('StakeBridge: "sessionID" missing from URL parameters');
  }
  const rgsUrl = params.get('rgs_url');
  if (!rgsUrl) {
    throw new Error('StakeBridge: "rgs_url" missing from URL parameters');
  }

  const device = params.get('device') ?? 'desktop';
  if (device !== 'desktop' && device !== 'mobile') {
    throw new Error(`StakeBridge: unsupported device type "${device}"`);
  }

  return {
    sessionID,
    rgsUrl,
    lang: params.get('lang') ?? 'en',
    device,
  };
}

export class RGSClient {
  private readonly base: string;
  private readonly sessionID: string;
  private readonly lang: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: RGSClientOptions) {
    this.sessionID = options.url.sessionID;
    this.lang = options.url.lang;
    const proto = options.protocol ?? 'https';
    this.base = `${proto}://${options.url.rgsUrl}`;
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
  }

  authenticate<TBook = unknown>(): Promise<RGSAuthenticateResponse<TBook>> {
    return this.post<RGSAuthenticateResponse<TBook>>('/wallet/authenticate', {
      sessionID: this.sessionID,
      language: this.lang,
    });
  }

  balance(): Promise<{ balance: RGSBalance }> {
    return this.post('/wallet/balance', { sessionID: this.sessionID });
  }

  play<TBook = unknown>(params: RGSPlayParams): Promise<RGSPlayResponse<TBook>> {
    return this.post<RGSPlayResponse<TBook>>('/wallet/play', {
      sessionID: this.sessionID,
      mode: params.mode,
      amount: params.amount,
    });
  }

  endRound(): Promise<RGSEndRoundResponse> {
    return this.post<RGSEndRoundResponse>('/wallet/end-round', {
      sessionID: this.sessionID,
    });
  }

  event(eventValue: string): Promise<RGSEventResponse> {
    return this.post<RGSEventResponse>('/bet/event', {
      sessionID: this.sessionID,
      event: eventValue,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      throw new RGSError(0, 'ERR_NET', `Network error calling ${path}: ${String(err)}`);
    }

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // ignore — non-JSON body
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
      throw new RGSError(response.status, code, message);
    }

    return data as T;
  }
}
