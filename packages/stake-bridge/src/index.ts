/**
 * Stake Engine integration.
 *
 * Drop-in host-side wrapper that lets a game built against
 * `CasinoGameSDK` run on Stake Engine without changes.
 *
 * ```ts
 * import { StakeBridge } from '@energy8platform/stake-bridge';
 * import adapter from './stake-adapter';
 *
 * const bridge = new StakeBridge({
 *   devMode: true,
 *   adapter,
 *   modeMap: { spin: 'BASE', buy_bonus: 'BONUS' },
 *   gameId: 'sweet-bonanza',
 *   debug: true,
 * });
 * ```
 */

export { StakeBridge } from './bridge';
export {
  RGSClient,
  RGSError,
  API_MULTIPLIER,
  parseStakeUrl,
  type RGSAuthenticateResponse,
  type RGSPlayResponse,
  type RGSEndRoundResponse,
  type RGSEventResponse,
  type RGSReplayResponse,
  type RGSReplayParams,
  type RGSBalance,
  type RGSPlayParams,
  type RGSClientOptions,
  type RetryPolicy,
} from './rgs-client';
export {
  defaultAdapterUrl,
  loadAdapter,
  resolveAdapter,
} from './adapter-loader';
export {
  CURRENCY_META,
  lookupCurrency,
  formatAmount,
  type FormatAmountOptions,
} from './currency';
export {
  SOCIAL_REPLACEMENTS,
  applySocialReplacements,
  type SocialReplacementRule,
} from './social';
export {
  DEFAULT_DISCLAIMER_LINES,
  buildDisclaimer,
} from './disclaimer';
export type {
  StakeBridgeOptions,
  BookAdapter,
  BookSegment,
  RoundContext,
  StakeRound,
  StakeUrlParams,
  StakeReplayParams,
  ModeMap,
  AdapterModule,
  AdapterFactoryOptions,
  SegmentResult,
} from './types';
