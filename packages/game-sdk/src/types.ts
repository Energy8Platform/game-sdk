/**
 * Public types for game developers.
 *
 * These are the types exposed through the SDK's promise-based API.
 * They use camelCase naming to match JavaScript conventions.
 * The host is responsible for mapping backend snake_case → camelCase.
 *
 * Re-exports protocol payloads that are part of the public contract.
 */

export type {
  WinLineData as WinLine,
  AnywhereWinData as AnywhereWin,
  GameConfigData as GameConfig,
  SymbolData as SymbolInfo,
  PaylineData as PaylineInfo,
  SessionData as SessionState,
  BonusFreeSpinData as BonusFreeSpin,
  JurisdictionFlagsData as JurisdictionFlags,
} from './protocol';

// ─── SDK Input Parameters ────────────────────────────────────────────

/** Universal play request parameters. */
export interface PlayParams {
  /** Action to execute (e.g. "spin", "free_spin", "buy_bonus", "pick") */
  action: string;
  /** Total bet amount */
  bet: number;
  /** Round ID for session-based actions (e.g. free spins, picks) */
  roundId?: string;
  /** Game-specific parameters */
  params?: Record<string, unknown>;
}


// ─── SDK Return Types ────────────────────────────────────────────────

export interface InitData {
  /** Player currency (e.g. "USD") */
  currency: string;
  /** Player balance */
  balance: number;
  /** Full game configuration */
  config: import('./protocol').GameConfigData;
  /** Active session to resume, or null */
  session: import('./protocol').SessionData | null;
  /** Base URL for game assets in S3 */
  assetsUrl?: string;
  /** ISO 639-1 language code passed by the operator. */
  lang?: string;
  /** Device hint passed by the operator. */
  device?: 'desktop' | 'mobile';
}

/** Universal play result. */
export interface PlayResultData {
  /** Unique identifier for this game round */
  roundId: string;
  /** Action that was executed */
  action: string;
  /** Player balance after the action */
  balanceAfter: number;
  /** Total win amount */
  totalWin: number;
  /** Player currency */
  currency: string;
  /** Game identifier */
  gameId: string;
  /** Game-specific output data (matrix, win_lines, multiplier, etc.) */
  data: Record<string, unknown>;
  /** Actions the client can invoke next */
  nextActions: string[];
  /** Session state, if a session is active */
  session?: import('./protocol').SessionData | null;
  /** True if win credit was deferred (server-side retry) */
  creditPending?: boolean;
  /** Bonus free spin grant info, if applicable */
  bonusFreeSpin?: import('./protocol').BonusFreeSpinData | null;
}

export interface BalanceData {
  balance: number;
}

// ─── SDK Options ─────────────────────────────────────────────────────

export interface CasinoGameSDKOptions {
  /**
   * Expected origin of the parent (host) window.
   * Defaults to the origin of `document.referrer`.
   * Set explicitly for stricter security. Use `'*'` only in development.
   */
  parentOrigin?: string;

  /**
   * Default timeout for request-response calls in milliseconds.
   * @default 15000
   */
  timeout?: number;

  /**
   * Enable debug logging of all sent and received messages.
   * Logs format: [GUEST -> HOST] / [HOST -> GUEST] MessageType payload
   * @default false
   */
  debug?: boolean;

  /**
   * Enable dev mode for running without an iframe.
   *
   * When `true`, the SDK uses an in-memory channel (`MemoryChannel`)
   * instead of `window.postMessage`. The host-side `Bridge` must also
   * be created with `devMode: true` in the same page — they connect
   * through `window.__casinoBridgeChannel`.
   *
   * @default false
   */
  devMode?: boolean;
}
