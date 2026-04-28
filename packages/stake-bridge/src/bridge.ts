/**
 * StakeBridge — a thick host-side wrapper that lets a game built against
 * `CasinoGameSDK` run on Stake Engine without changes.
 *
 * On the iframe boundary StakeBridge speaks the same `__casino_bridge`
 * protocol our regular `Bridge` does. Internally it talks to Stake's
 * RGS API, splits each round's pre-generated "book" into segments via
 * a per-game `BookAdapter`, and streams those segments back to the
 * game one PLAY_REQUEST at a time.
 *
 * What the bridge owns:
 *  - URL parsing (sessionID, rgs_url, lang, device)
 *  - Authenticate / Play / EndRound / Event / Balance calls
 *  - Money conversion (decimal ↔ minor units × 1_000_000)
 *  - Segment cursor + creditPending lifecycle
 *  - Bet validation against authenticate config
 *  - Idle balance polling
 *
 * What the game's adapter owns:
 *  - splitRound(book, ctx) → BookSegment[]   (game-specific data shape)
 *  - resumeFrom(book, lastEvent, ctx)        (optional; defaults to 0)
 *  - enrichConfig(config)                    (optional)
 */

import { Bridge } from '@energy8platform/game-sdk';
import type {
  GameReadyPayload,
  GetBalancePayload,
  GetStatePayload,
  OpenDepositPayload,
  PlayRequestPayload,
  PlayResultAckPayload,
  PlayResultPayload,
  PlayErrorPayload,
  InitPayload,
  BalanceUpdatePayload,
  StateResponsePayload,
  ConnectionStatePayload,
  GameConfigData,
  SessionData,
  JurisdictionFlagsData,
  AutoplayPolicyData,
} from '@energy8platform/game-sdk/protocol';
import {
  RGSClient,
  RGSError,
  API_MULTIPLIER,
  parseStakeUrl,
  type RGSAuthenticateResponse,
  type RGSPlayResponse,
  type RGSReplayResponse,
} from './rgs-client';
import { loadAdapter, resolveAdapter } from './adapter-loader';
import { lookupCurrency } from './currency';
import { buildDisclaimer } from './disclaimer';
import type {
  BookAdapter,
  BookSegment,
  ModeMap,
  RoundContext,
  StakeBridgeOptions,
  StakeUrlParams,
} from './types';

interface ActiveRound {
  roundId: string;
  betID: number;
  mode: string;
  triggerAction: string;
  betAmount: number;
  payoutMultiplier: number;
  costMultiplier: number;
  /** Whether RGS still considers the round open (i.e. EndRound is required). */
  rgsActive: boolean;
  segments: BookSegment[];
  /** Index of the segment that will be served next. */
  cursor: number;
  /** Cumulative win across served segments, decimal. */
  totalWin: number;
  /** True once /wallet/end-round has been called for this round. */
  endRoundCalled: boolean;
  /** Last segment we have already streamed back to the game (for GET_STATE). */
  lastDelivered: PlayResultPayload | null;
  /** Bet mode used to play. */
  rawBook: unknown;
  /** Last event marker reported to /bet/event for this round. */
  lastEventMarker?: string;
}

/** Convert Stake minor units → decimal currency-major. */
function fromMinor(amount: number): number {
  return amount / API_MULTIPLIER;
}

/** Convert decimal currency-major → Stake minor units (rounded to integer). */
function toMinor(amount: number): number {
  return Math.round(amount * API_MULTIPLIER);
}

export class StakeBridge {
  private readonly bridge: Bridge;
  private readonly rgs: RGSClient;
  private readonly url: StakeUrlParams;
  private readonly modeMap: ModeMap;
  private readonly gameId: string;
  private readonly assetsUrl: string;
  private readonly enforceBetLevels: boolean;
  private readonly balancePollMs: number;
  private readonly debug: boolean;

  private adapter: BookAdapter | null = null;
  private adapterLoad: Promise<BookAdapter>;

  /** Whether we were launched as a historical replay (`?replay=true&...`). */
  private readonly isReplay: boolean;
  /**
   * Cached replay book — fetched from `/bet/replay/...` on the first
   * play request and re-served on subsequent "Play Again" calls.
   */
  private replayBook: RGSReplayResponse | null = null;

  /** Resolves once boot (live `Authenticate` or replay synthesis) has completed. */
  private bootPromise: Promise<RGSAuthenticateResponse> | null = null;
  private authData: RGSAuthenticateResponse | null = null;
  private balance = 0;
  private currency = 'USD';

  private active: ActiveRound | null = null;
  private destroyed = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Map from PLAY_REQUEST id → segment index that was served. Used by ACK. */
  private servedByRequestId = new Map<string, { round: ActiveRound; index: number }>();

  constructor(options: StakeBridgeOptions) {
    const devMode = options.devMode ?? false;

    if (!devMode && !options.iframe) {
      throw new Error(
        'StakeBridge: pass either `devMode: true` (in-process) or an `iframe` element',
      );
    }
    if (!options.adapter && !options.adapterUrl) {
      throw new Error(
        'StakeBridge: provide `adapter` (recommended — pass your imported adapter) or `adapterUrl` (dynamic import escape hatch)',
      );
    }

    this.bridge = new Bridge({
      devMode,
      iframe: options.iframe,
      targetOrigin: options.targetOrigin ?? '*',
      debug: options.debug,
    });

    this.url = parseStakeUrl(options.url ?? window.location.href);
    this.isReplay = !!this.url.replay;
    this.rgs = new RGSClient({
      url: this.url,
      protocol: options.protocol ?? 'https',
      onConnectionState: (state) => this.emitConnectionState(state),
    });

    this.modeMap = options.modeMap ?? {};
    this.gameId = options.gameId ?? '';
    this.assetsUrl = options.assetsUrl ?? options.iframe?.src ?? '';
    this.enforceBetLevels = options.enforceBetLevels ?? true;
    this.balancePollMs = options.balancePollMs ?? 60_000;
    this.debug = options.debug ?? false;

    this.adapterLoad = this.bootstrapAdapter(options);
    this.subscribe();

    // Kick off boot (Authenticate or replay setup) eagerly so it's ready
    // by the time GAME_READY arrives.
    this.bootPromise = this.boot();
  }

  private emitConnectionState(state: ConnectionStatePayload): void {
    this.log(`connection ${state.status}${state.code ? ` (${state.code})` : ''}`);
    this.bridge.send<ConnectionStatePayload>('CONNECTION_STATE', state);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Tear down. Cancels the balance poll, removes listeners. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopBalancePolling();
    this.bridge.destroy();
  }

  /**
   * Promise that resolves once boot (Authenticate or replay setup) and
   * adapter load are both done. Useful for tests / advanced setups.
   */
  ready(): Promise<void> {
    return Promise.all([this.bootPromise, this.adapterLoad]).then(() => undefined);
  }

  // ─── Adapter bootstrap ───────────────────────────────────────────────

  private async bootstrapAdapter(options: StakeBridgeOptions): Promise<BookAdapter> {
    const factoryOpts = {
      mode: this.modeMap.default ?? 'BASE',
      url: this.url,
    };

    if (options.adapter) {
      this.adapter = await resolveAdapter(options.adapter, factoryOpts);
      return this.adapter;
    }

    // adapterUrl: dynamic-import escape hatch. Constructor already validated
    // that one of `adapter` / `adapterUrl` is set.
    const url = options.adapterUrl!;
    this.log(`loading adapter from ${url}`);
    this.adapter = await loadAdapter(url, factoryOpts);
    return this.adapter;
  }

  // ─── Message subscriptions ───────────────────────────────────────────

  private subscribe(): void {
    this.bridge.on<GameReadyPayload>('GAME_READY', (_payload, id) =>
      this.onGameReady(id),
    );
    this.bridge.on<PlayRequestPayload>('PLAY_REQUEST', (payload, id) =>
      this.onPlayRequest(payload, id),
    );
    this.bridge.on<PlayResultAckPayload>('PLAY_RESULT_ACK', (payload, id) =>
      this.onPlayAck(payload, id),
    );
    this.bridge.on<GetBalancePayload>('GET_BALANCE', (_payload, id) =>
      this.onGetBalance(id),
    );
    this.bridge.on<GetStatePayload>('GET_STATE', (_payload, id) =>
      this.onGetState(id),
    );
    this.bridge.on<OpenDepositPayload>('OPEN_DEPOSIT', () => {
      this.log('OPEN_DEPOSIT received — no-op on Stake');
    });
  }

  // ─── Boot (Authenticate or replay setup) ─────────────────────────────

  /**
   * Branches on URL launch mode:
   *  - **Wallet** (`?sessionID=...`): full `/wallet/authenticate` round-trip,
   *    starts balance polling, may resume an in-flight round.
   *  - **Replay** (`?replay=true&...`): no auth, no polling, synthetic
   *    config built from URL parameters.
   *
   * Both branches resolve with an `RGSAuthenticateResponse`-shaped value
   * so downstream code (validateBet, buildGameConfig) can be agnostic.
   */
  private async boot(): Promise<RGSAuthenticateResponse> {
    if (this.isReplay) return this.bootReplay();
    return this.authenticate();
  }

  private async bootReplay(): Promise<RGSAuthenticateResponse> {
    const r = this.url.replay!;
    this.balance = 0;
    this.currency = r.currency;

    // Synthesize an authData-shaped object so `buildGameConfig`, the
    // validateBet code path, and any other consumer keep working.
    const synth: RGSAuthenticateResponse = {
      balance: { amount: 0, currency: r.currency },
      round: null,
      config: {
        gameID: this.gameId || r.game,
        minBet: r.amount,
        maxBet: r.amount,
        stepBet: r.amount,
        defaultBetLevel: r.amount,
        betLevels: [r.amount],
        betModes: { [r.mode]: {} },
        jurisdiction: undefined,
      },
    };
    this.authData = synth;
    this.log(
      `replay boot: game=${r.game} version=${r.version} mode=${r.mode} event=${r.event} amount=${r.amount} currency=${r.currency}`,
    );
    return synth;
  }

  private async authenticate(): Promise<RGSAuthenticateResponse> {
    const data = await this.rgs.authenticate();
    this.authData = data;
    this.balance = fromMinor(data.balance.amount);
    this.currency = data.balance.currency;
    this.startBalancePolling();

    if (data.round && data.round.active) {
      // Active round detected on session resume — materialize a cursor.
      await this.adapterLoad;
      const ctx = this.makeRoundContext(data.round);
      const segments = this.adapter!.splitRound(data.round.state, ctx);
      const cursor = this.adapter!.resumeFrom?.(
        data.round.state,
        data.round.event,
        ctx,
      ) ?? 0;
      this.active = {
        roundId: ctx.roundId,
        betID: data.round.betID,
        mode: data.round.mode,
        triggerAction: ctx.triggerAction,
        betAmount: ctx.betAmount,
        payoutMultiplier: data.round.payoutMultiplier,
        costMultiplier: data.round.costMultiplier ?? 1,
        rgsActive: true,
        segments,
        cursor: Math.max(0, Math.min(cursor, segments.length - 1)),
        totalWin: this.sumWinUpTo(segments, cursor),
        endRoundCalled: false,
        lastDelivered: null,
        rawBook: data.round.state,
        lastEventMarker: data.round.event,
      };
      this.log(
        `resumed round betID=${data.round.betID} cursor=${this.active.cursor}/${segments.length}`,
      );
    }

    return data;
  }

  // ─── INIT ────────────────────────────────────────────────────────────

  private async onGameReady(id?: string): Promise<void> {
    try {
      const auth = await this.bootPromise!;
      await this.adapterLoad;

      const cfg = this.buildGameConfig(auth);
      const session = this.synthesizeSessionForResume();

      const init: InitPayload = {
        balance: this.balance,
        currency: this.currency,
        config: cfg,
        session,
        assetsUrl: this.assetsUrl || undefined,
        lang: this.url.lang,
        device: this.url.device,
      };
      this.bridge.send('INIT', init, id);
    } catch (err) {
      this.bridge.send(
        'ERROR',
        { code: this.errCode(err), message: this.errMessage(err) },
        id,
      );
    }
  }

  private buildGameConfig(auth: RGSAuthenticateResponse): GameConfigData {
    const c = auth.config;
    const jurisdiction = (c.jurisdiction ?? undefined) as
      | JurisdictionFlagsData
      | undefined;

    const socialMode = !!this.url.social || !!jurisdiction?.socialCasino;
    const demo = !!this.url.demo;

    const baseConfig: GameConfigData = {
      id: this.gameId || c.gameID || 'unknown',
      type: 'slot',
      betLevels: c.betLevels.map(fromMinor),
      betModes: c.betModes,
      jurisdiction,
      currency: lookupCurrency(this.currency),
      autoplay: this.deriveAutoplayPolicy(jurisdiction),
      replayMode: this.isReplay,
      socialMode,
      demo,
      disclaimerLines: buildDisclaimer({
        socialMode,
        replayMode: this.isReplay,
      }),
      // Stake-specific extras surfaced via index signature
      stake: {
        minBet: fromMinor(c.minBet),
        maxBet: fromMinor(c.maxBet),
        stepBet: fromMinor(c.stepBet),
        defaultBetLevel: fromMinor(c.defaultBetLevel),
      },
    };

    if (this.adapter?.enrichConfig) {
      try {
        return this.adapter.enrichConfig(baseConfig);
      } catch (err) {
        this.log(`adapter.enrichConfig threw — using bare config (${err})`);
      }
    }
    return baseConfig;
  }

  /**
   * Derive autoplay recommendations from jurisdiction flags.
   *
   * Returns `undefined` when the jurisdiction disables autoplay
   * outright. Otherwise advertises a sensible baseline (`maxCount`
   * = 100, mandatory feature-trigger stop) — the game is free to
   * narrow these further but should not exceed them.
   */
  private deriveAutoplayPolicy(
    j: JurisdictionFlagsData | undefined,
  ): AutoplayPolicyData | undefined {
    if (this.isReplay) return undefined;
    if (j?.disabledAutoplay) return undefined;
    return {
      maxCount: 100,
      requiredStops: ['feature-trigger'],
    };
  }

  private synthesizeSessionForResume(): SessionData | null {
    if (!this.active) return null;
    return this.synthSession(this.active);
  }

  // ─── PLAY_REQUEST ────────────────────────────────────────────────────

  private async onPlayRequest(
    payload: PlayRequestPayload,
    id?: string,
  ): Promise<void> {
    try {
      await this.bootPromise;
      await this.adapterLoad;

      // Continuation of an in-flight round?
      if (
        this.active &&
        payload.roundId &&
        payload.roundId === this.active.roundId
      ) {
        await this.streamNextSegment(payload, id);
        return;
      }

      // No matching active round — but if there IS an unfinished round,
      // either the game forgot to drain it or it's a spurious call.
      // Mirror Stake's own ts-client behaviour: refuse with a clear code.
      if (this.active && this.active.cursor < this.active.segments.length - 1) {
        this.bridge.send<PlayErrorPayload>(
          'PLAY_ERROR',
          {
            code: 'ACTIVE_SESSION_EXISTS',
            message:
              'An active round is in progress. Resume via getState() or finish remaining segments first.',
          },
          id,
        );
        return;
      }

      // Brand-new round.
      await this.startNewRound(payload, id);
    } catch (err) {
      this.bridge.send<PlayErrorPayload>(
        'PLAY_ERROR',
        { code: this.errCode(err), message: this.errMessage(err) },
        id,
      );
    }
  }

  private async startNewRound(
    payload: PlayRequestPayload,
    requestId?: string,
  ): Promise<void> {
    if (this.isReplay) {
      await this.startReplayRound(payload, requestId);
      return;
    }

    const auth = this.authData!;
    const mode = this.actionToMode(payload.action);
    const betAmount = payload.bet;
    const minor = toMinor(betAmount);

    this.validateBet(minor, auth);

    const playResp: RGSPlayResponse = await this.rgs.play({
      mode,
      amount: minor,
    });
    this.balance = fromMinor(playResp.balance.amount);
    this.startBalancePolling();

    const ctx: RoundContext = {
      mode: playResp.round.mode,
      triggerAction: payload.action,
      betAmount,
      payoutMultiplier: playResp.round.payoutMultiplier,
      currency: this.currency,
      roundId: String(playResp.round.betID),
    };

    const segments = this.adapter!.splitRound(playResp.round.state, ctx);
    if (!segments.length) {
      throw new Error('Adapter returned an empty segment list');
    }

    this.active = {
      roundId: ctx.roundId,
      betID: playResp.round.betID,
      mode: playResp.round.mode,
      triggerAction: payload.action,
      betAmount,
      payoutMultiplier: playResp.round.payoutMultiplier,
      costMultiplier: playResp.round.costMultiplier ?? 1,
      rgsActive: playResp.round.active,
      segments,
      cursor: 0,
      totalWin: 0,
      endRoundCalled: false,
      lastDelivered: null,
      rawBook: playResp.round.state,
    };

    await this.deliverSegment(0, requestId);
  }

  /**
   * Replay equivalent of `startNewRound`. Fetches the book once via
   * `/bet/replay/{game}/{version}/{mode}/{event}`, caches it, and
   * re-streams it on every subsequent "Play Again" — no `/wallet/play`,
   * no `/wallet/end-round`, no `/bet/event`.
   */
  private async startReplayRound(
    payload: PlayRequestPayload,
    requestId?: string,
  ): Promise<void> {
    const r = this.url.replay!;

    if (!this.replayBook) {
      this.replayBook = await this.rgs.replay({
        game: r.game,
        version: r.version,
        mode: r.mode,
        event: r.event,
      });
    }

    // The replay endpoint may return the book directly, or wrap it in
    // `state` (matching the `/wallet/play` round shape). Accept both.
    const bookData =
      (this.replayBook as { state?: unknown }).state ?? this.replayBook;
    const payoutMultiplier =
      (this.replayBook as { payoutMultiplier?: number }).payoutMultiplier ?? 0;
    const costMultiplier =
      (this.replayBook as { costMultiplier?: number }).costMultiplier ?? 1;

    const ctx: RoundContext = {
      mode: r.mode,
      triggerAction: payload.action,
      betAmount: fromMinor(r.amount),
      payoutMultiplier,
      currency: r.currency,
      roundId: r.event,
    };

    const segments = this.adapter!.splitRound(bookData, ctx);
    if (!segments.length) {
      throw new Error('Adapter returned an empty segment list (replay)');
    }

    this.active = {
      roundId: ctx.roundId,
      betID: 0,
      mode: r.mode,
      triggerAction: payload.action,
      betAmount: fromMinor(r.amount),
      payoutMultiplier,
      costMultiplier,
      // Replay rounds never need EndRound — they're not real bets.
      rgsActive: false,
      segments,
      cursor: 0,
      totalWin: 0,
      endRoundCalled: false,
      lastDelivered: null,
      rawBook: bookData,
    };

    await this.deliverSegment(0, requestId);
  }

  private async streamNextSegment(
    payload: PlayRequestPayload,
    requestId?: string,
  ): Promise<void> {
    const round = this.active!;
    const next = round.cursor + 1;
    if (next >= round.segments.length) {
      // Game asked for another segment but the book is exhausted. Surface
      // an error rather than silently looping.
      this.bridge.send<PlayErrorPayload>(
        'PLAY_ERROR',
        {
          code: 'NO_ACTIVE_SESSION',
          message: 'Round has no more segments. Start a new round.',
        },
        requestId,
      );
      return;
    }

    void payload; // future: validate payload.action against segment.action
    await this.deliverSegment(next, requestId);
  }

  /**
   * Build and send PLAY_RESULT for `index`. Calls `/wallet/end-round`
   * before the final segment if RGS still considers the round active.
   */
  private async deliverSegment(index: number, requestId?: string): Promise<void> {
    const round = this.active!;
    const segment = round.segments[index];
    const isFinal = index === round.segments.length - 1;

    let creditPending = round.rgsActive;
    let balanceAfter = this.balance;

    if (isFinal && round.rgsActive && !round.endRoundCalled) {
      try {
        const er = await this.rgs.endRound();
        round.endRoundCalled = true;
        round.rgsActive = false;
        this.balance = fromMinor(er.balance.amount);
        balanceAfter = this.balance;
        creditPending = false;
        this.startBalancePolling();
      } catch (err) {
        // Surface the error but keep the round in place so the game can retry.
        this.bridge.send<PlayErrorPayload>(
          'PLAY_ERROR',
          { code: this.errCode(err), message: this.errMessage(err) },
          requestId,
        );
        return;
      }
    }

    round.cursor = index;
    round.totalWin = this.sumWinUpTo(round.segments, index);

    const result: PlayResultPayload = {
      roundId: round.roundId,
      action: segment.action,
      balanceAfter,
      totalWin: round.totalWin,
      currency: this.currency,
      gameId: this.gameId,
      data: segment.data as Record<string, unknown>,
      nextActions: segment.nextActions,
      session: this.synthSession(round, segment),
      creditPending,
      bonusFreeSpin: segment.bonusFreeSpin ?? null,
    };

    round.lastDelivered = result;
    if (requestId) {
      this.servedByRequestId.set(requestId, { round, index });
    }
    this.bridge.send('PLAY_RESULT', result, requestId);

    // Push a fresh balance update too (defensive — the game's SDK already
    // updates from PLAY_RESULT but other host UI might subscribe).
    this.bridge.send<BalanceUpdatePayload>('BALANCE_UPDATE', {
      balance: balanceAfter,
    });

    if (isFinal) {
      // Round closed — drop the cursor.
      this.active = null;
    }
  }

  private synthSession(
    round: ActiveRound,
    segment?: BookSegment,
  ): SessionData | null {
    const total = round.segments.length;
    const seg = segment ?? round.segments[round.cursor];
    if (seg.session === null) return null;
    if (total <= 1 && !seg.session) {
      // Single-segment rounds: no session by default.
      return null;
    }
    const base: SessionData = {
      spinsRemaining: total - 1 - round.cursor,
      spinsPlayed: round.cursor + 1,
      totalWin: round.totalWin,
      completed: round.cursor === total - 1,
      betAmount: round.betAmount,
    };
    return seg.session ? { ...base, ...seg.session } : base;
  }

  // ─── PLAY_RESULT_ACK ─────────────────────────────────────────────────

  private onPlayAck(payload: PlayResultAckPayload, id?: string): void {
    void id;
    const round = this.active ?? this.lookupRoundForAck(payload);
    if (!round) return;
    const segment = round.segments[round.cursor];
    const marker = segment?.progressMarker ?? `seg-${round.cursor}`;
    round.lastEventMarker = marker;
    // Replay rounds aren't tracked by RGS — skip /bet/event.
    if (this.isReplay) return;
    // Fire-and-forget. /bet/event failures don't disrupt gameplay.
    this.rgs.event(marker).catch((err) => this.log(`event() failed: ${err}`));
  }

  private lookupRoundForAck(payload: PlayResultAckPayload): ActiveRound | null {
    // After the final segment we clear `this.active`; the ACK still arrives
    // afterwards, so look up by roundId in any segments map kept by request.
    for (const { round } of this.servedByRequestId.values()) {
      if (round.roundId === payload.roundId) return round;
    }
    return null;
  }

  // ─── GET_BALANCE ─────────────────────────────────────────────────────

  private async onGetBalance(id?: string): Promise<void> {
    if (this.isReplay) {
      // No wallet to read — return the synthetic 0 balance.
      this.bridge.send<BalanceUpdatePayload>(
        'BALANCE_UPDATE',
        { balance: this.balance },
        id,
      );
      return;
    }
    try {
      const { balance } = await this.rgs.balance();
      this.balance = fromMinor(balance.amount);
      this.startBalancePolling();
      this.bridge.send<BalanceUpdatePayload>(
        'BALANCE_UPDATE',
        { balance: this.balance },
        id,
      );
    } catch (err) {
      this.bridge.send(
        'ERROR',
        { code: this.errCode(err), message: this.errMessage(err) },
        id,
      );
    }
  }

  // ─── GET_STATE ───────────────────────────────────────────────────────

  private onGetState(id?: string): void {
    if (!this.active) {
      this.bridge.send<StateResponsePayload>(
        'STATE_RESPONSE',
        { session: null },
        id,
      );
      return;
    }
    // Replay the segment at the current cursor without advancing it.
    // Note: GET_STATE returns a snapshot; balance reflects whatever the
    // bridge currently holds (post-debit if RGS still active).
    const segment = this.active.segments[this.active.cursor];
    const snapshot: PlayResultPayload = {
      roundId: this.active.roundId,
      action: segment.action,
      balanceAfter: this.balance,
      totalWin: this.sumWinUpTo(this.active.segments, this.active.cursor),
      currency: this.currency,
      gameId: this.gameId,
      data: segment.data as Record<string, unknown>,
      nextActions: segment.nextActions,
      session: this.synthSession(this.active, segment),
      creditPending: this.active.rgsActive,
      bonusFreeSpin: segment.bonusFreeSpin ?? null,
    };
    this.bridge.send<StateResponsePayload>(
      'STATE_RESPONSE',
      { session: snapshot },
      id,
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private actionToMode(action: string): string {
    const mapped = this.modeMap[action];
    if (mapped) return mapped;
    if (this.modeMap.default) return this.modeMap.default;
    // Default fallback: uppercase the action.
    return action.toUpperCase();
  }

  private validateBet(minor: number, auth: RGSAuthenticateResponse): void {
    const c = auth.config;
    if (minor < c.minBet || minor > c.maxBet) {
      throw new Error(
        `Bet ${fromMinor(minor)} is out of range [${fromMinor(c.minBet)}, ${fromMinor(c.maxBet)}]`,
      );
    }
    if (c.stepBet > 0 && minor % c.stepBet !== 0) {
      throw new Error(
        `Bet ${fromMinor(minor)} is not a multiple of step ${fromMinor(c.stepBet)}`,
      );
    }
    if (this.enforceBetLevels && !c.betLevels.includes(minor)) {
      throw new Error(
        `Bet ${fromMinor(minor)} is not one of the configured bet levels`,
      );
    }
  }

  private makeRoundContext<T>(round: { betID: number; mode: string; payoutMultiplier: number; amount?: number; state: T }): RoundContext {
    return {
      mode: round.mode,
      triggerAction: this.invertMode(round.mode),
      betAmount: round.amount != null ? fromMinor(round.amount) : 0,
      payoutMultiplier: round.payoutMultiplier,
      currency: this.currency,
      roundId: String(round.betID),
    };
  }

  /** Best-effort reverse mapping (Stake mode → our action) for resume. */
  private invertMode(mode: string): string {
    for (const [action, m] of Object.entries(this.modeMap)) {
      if (m === mode) return action;
    }
    return mode.toLowerCase();
  }

  private sumWinUpTo(segments: BookSegment[], inclusiveIndex: number): number {
    let total = 0;
    for (let i = 0; i <= inclusiveIndex; i++) total += segments[i]?.winThisSegment ?? 0;
    return total;
  }

  private startBalancePolling(): void {
    if (this.isReplay) return;
    this.stopBalancePolling();
    if (this.balancePollMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.refreshBalance().catch(() => {
        /* swallow — polling is best-effort */
      });
    }, this.balancePollMs);
  }

  private stopBalancePolling(): void {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshBalance(): Promise<void> {
    if (this.destroyed) return;
    const { balance } = await this.rgs.balance();
    const next = fromMinor(balance.amount);
    if (next !== this.balance) {
      this.balance = next;
      this.bridge.send<BalanceUpdatePayload>('BALANCE_UPDATE', {
        balance: next,
      });
    }
  }

  private errCode(err: unknown): string {
    if (err instanceof RGSError) return err.code;
    return 'INTERNAL';
  }

  private errMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private log(msg: string): void {
    if (!this.debug) return;
    console.debug(
      `%cstake-bridge%c ${msg}`,
      'color: #f59e0b; font-weight: bold',
      'color: inherit',
    );
  }
}

// ─── Type re-exports for convenience ─────────────────────────────────

export type {
  StakeBridgeOptions,
  BookAdapter,
  BookSegment,
  RoundContext,
  ModeMap,
} from './types';
