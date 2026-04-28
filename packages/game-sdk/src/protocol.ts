/**
 * Casino Platform Game Bridge Protocol v2
 *
 * Defines all message types exchanged between the Host (casino shell)
 * and the Guest (game iframe) via window.postMessage.
 *
 * The Host is responsible for all API interactions.
 * The Guest (game) never has direct access to the backend or JWT tokens.
 */

// ─── Message Types ───────────────────────────────────────────────────

/** Messages sent from Guest (game iframe) → Host (casino shell) */
export type GuestMessageType =
  | 'GAME_READY'
  | 'PLAY_REQUEST'
  | 'PLAY_RESULT_ACK'
  | 'GET_BALANCE'
  | 'GET_STATE'
  | 'OPEN_DEPOSIT';

/** Messages sent from Host (casino shell) → Guest (game iframe) */
export type HostMessageType =
  | 'INIT'
  | 'PLAY_RESULT'
  | 'PLAY_ERROR'
  | 'BALANCE_UPDATE'
  | 'STATE_RESPONSE'
  | 'CONNECTION_STATE'
  | 'ERROR';

export type BridgeMessageType = GuestMessageType | HostMessageType;

// ─── Envelope ────────────────────────────────────────────────────────

export interface BridgeMessage<T = unknown> {
  /** Protocol identifier to filter unrelated postMessage events */
  __casino_bridge: true;
  /** Message type */
  type: BridgeMessageType;
  /** Message payload */
  payload: T;
  /** UUID for request‑response correlation */
  id?: string;
}

// ─── Guest → Host Payloads ───────────────────────────────────────────

export interface GameReadyPayload {}

export interface GetBalancePayload {}

export interface GetStatePayload {}

export interface OpenDepositPayload {}

export interface PlayResultAckPayload {
  /** Round ID being acknowledged */
  roundId: string;
  /** Action that was executed */
  action: string;
  /** Total win amount from the result */
  totalWin: number;
  /** Player balance after the action */
  balanceAfter: number;
}

// ─── Universal Play Request/Result ───────────────────────────────────

export interface PlayRequestPayload {
  /** Action to execute (e.g. "spin", "free_spin", "buy_bonus", "pick") */
  action: string;
  /** Bet amount */
  bet: number;
  /** Round ID for session-based actions */
  roundId?: string;
  /** Game-specific parameters */
  params?: Record<string, unknown>;
}

export interface BonusFreeSpinData {
  grantId: number;
  remainingSpins: number;
}

export interface PlayResultPayload {
  roundId: string;
  action: string;
  balanceAfter: number;
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
  session?: SessionData | null;
  /** True if win credit was deferred (server-side retry) */
  creditPending?: boolean;
  /** Bonus free spin grant info, if applicable */
  bonusFreeSpin?: BonusFreeSpinData | null;
}

export interface PlayErrorPayload {
  code: string;
  message: string;
}

// ─── Host → Guest Payloads ───────────────────────────────────────────

export interface WinLineData {
  paylineIndex: number;
  symbolId: number;
  count: number;
  payout: number;
}

export interface AnywhereWinData {
  symbolId: number;
  count: number;
  payout: number;
  positions: [number, number][];
}

export interface InitPayload {
  currency: string;
  balance: number;
  config: GameConfigData;
  session?: SessionData | null;
  /** Base URL for game assets in S3 (e.g. http://localhost:9000/bucket/games/{id}/bundle/) */
  assetsUrl?: string;
  /** ISO 639-1 language code passed by the operator (e.g. 'en', 'ru'). */
  lang?: string;
  /** Device hint passed by the operator. */
  device?: 'desktop' | 'mobile';
}

/**
 * Operator/jurisdiction-driven feature flags.
 *
 * Some operators (e.g. Stake) require games to honour these flags.
 * On platforms that don't supply them the field is simply absent and
 * games behave as if all features are allowed.
 */
export interface JurisdictionFlagsData {
  socialCasino?: boolean;
  disabledFullscreen?: boolean;
  disabledTurbo?: boolean;
  disabledSuperTurbo?: boolean;
  disabledAutoplay?: boolean;
  disabledSlamstop?: boolean;
  disabledSpacebar?: boolean;
  disabledBuyFeature?: boolean;
  displayNetPosition?: boolean;
  displayRTP?: boolean;
  displaySessionTimer?: boolean;
  /** Minimum round duration in ms; the game must not finalize a round faster than this. */
  minimumRoundDuration?: number;
}

export interface GameConfigData {
  id: string;
  type: string;
  version?: string;
  viewport?: { width: number; height: number };
  betLevels?: number[];
  symbols?: Record<string, SymbolData>;
  paylines?: PaylineData[];
  evaluationMode?: string;
  /** Operator-supplied feature flags. Undefined on platforms that don't use jurisdictions. */
  jurisdiction?: JurisdictionFlagsData;
  /**
   * Per-mode configuration (e.g. `{ BASE: {...}, BONUS: {...} }`).
   * Shape is operator/game specific.
   */
  betModes?: Record<string, unknown>;
  /**
   * Currency metadata for display (symbol, decimals, placement).
   * Set by hosts that know the player's currency at INIT time.
   */
  currency?: CurrencyMetaData;
  /**
   * Autoplay rules the operator wants the game UI to honour. Bridge
   * advertises these as recommendations; hard enforcement is up to
   * the game.
   */
  autoplay?: AutoplayPolicyData;
  /**
   * `true` when the game is being launched as a historical-round
   * replay (no wallet, no end-round). The game should hide the
   * balance / bet selector / autoplay / buy-bonus UI and surface
   * a "Play / Play Again" CTA only.
   */
  replayMode?: boolean;
  /**
   * `true` when the operator marks the session as social-casino
   * (sweepstakes etc.). Games are expected to swap loss/win/wager
   * vocabulary using the helper exposed by the host.
   */
  socialMode?: boolean;
  /**
   * `true` when the launch is a demo / free-play session. No real
   * balance is affected. Games typically render a "DEMO" banner and
   * may default to a fixed demo balance.
   */
  demo?: boolean;
  /**
   * Operator-required disclaimer lines (malfunction-void, RGS
   * source-of-truth etc.). The game is expected to render these
   * verbatim in its info / paytable screen.
   */
  disclaimerLines?: string[];
  [key: string]: unknown;
}

export interface SymbolData {
  id: number;
  isWild?: boolean;
  isScatter?: boolean;
  isMultiplier?: boolean;
  multiplier?: number;
}

export interface PaylineData {
  positions: number[];
  payouts: Record<string, number>;
}

export interface BalanceUpdatePayload {
  balance: number;
}

/**
 * Pushed by the host whenever the connection state to its backend
 * changes (e.g. fetch retries on the RGS hit, network goes away,
 * round can't be finalized). Games typically render an overlay on
 * `lost` and dismiss it on `restored`.
 */
export interface ConnectionStatePayload {
  status: 'lost' | 'restored' | 'connecting';
  /** Optional error code from the underlying transport / RGS. */
  code?: string;
  /** Optional human-readable hint. */
  message?: string;
}

/** Currency metadata derived from the operator's currency code. */
export interface CurrencyMetaData {
  /** ISO 4217 code (e.g. 'USD'). */
  code: string;
  /** Default decimal places for display (e.g. 2 for USD, 0 for JPY). */
  decimals: number;
  /** Display symbol (e.g. '$', '€', 'kr'). */
  symbol: string;
  /** Whether the symbol comes after the amount (e.g. `10 zł`). */
  symbolAfter?: boolean;
}

/**
 * Operator-driven autoplay constraints (Stake jurisdictions).
 *
 * The host advertises *recommendations* — games render UI to honour
 * them. Hard enforcement (e.g. rejecting plays past `maxCount`) is
 * the game's responsibility; the host won't refuse a play purely
 * because autoplay rules were ignored.
 */
export interface AutoplayPolicyData {
  /** Maximum spins per autoplay run, if the jurisdiction caps it. */
  maxCount?: number;
  /**
   * Stops the autoplay UI must surface to the player. Common values:
   *   - `'loss-limit'` — stop at user-defined cumulative loss
   *   - `'single-win-limit'` — stop on a single win above N
   *   - `'feature-trigger'` — stop on free spins / bonus trigger
   */
  requiredStops?: Array<'loss-limit' | 'single-win-limit' | 'feature-trigger' | string>;
}

export interface SessionData {
  /** Number of remaining session actions (e.g. free spins, picks) */
  spinsRemaining: number;
  /** Number of session actions already played */
  spinsPlayed: number;
  /** Cumulative session win */
  totalWin: number;
  /** Whether the session has been completed */
  completed?: boolean;
  /** Whether the max win cap was reached */
  maxWinReached?: boolean;
  /** Last bet amount */
  betAmount?: number;
  /** Session round history */
  history?: Array<{ spinIndex: number; win: number; data: Record<string, unknown> }>;
}

export interface StateResponsePayload {
  session: PlayResultPayload | null;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Type guard: is this event a Casino Bridge message? */
export function isBridgeMessage(data: unknown): data is BridgeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    '__casino_bridge' in data &&
    (data as BridgeMessage).__casino_bridge === true &&
    'type' in data &&
    typeof (data as BridgeMessage).type === 'string'
  );
}

/** Create a properly shaped bridge message */
export function createMessage<T>(
  type: BridgeMessageType,
  payload: T,
  id?: string,
): BridgeMessage<T> {
  return { __casino_bridge: true, type, payload, id };
}
