/**
 * Stake Engine integration.
 *
 * Drop-in host-side wrapper that lets a game built against
 * `CasinoGameSDK` run on Stake Engine without changes.
 *
 * ```ts
 * import { StakeBridge } from '@energy8platform/game-sdk/stake';
 *
 * const bridge = new StakeBridge({
 *   iframe: document.getElementById('game') as HTMLIFrameElement,
 *   modeMap: { spin: 'BASE', buy_bonus: 'BONUS' },
 *   gameId: 'sweet-bonanza',
 *   debug: true,
 *   // adapter loaded by convention from `<assetsUrl>/stake-adapter.js`
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
  type RGSBalance,
  type RGSPlayParams,
  type RGSClientOptions,
} from './rgs-client';
export {
  defaultAdapterUrl,
  loadAdapter,
  resolveAdapter,
} from './adapter-loader';
export type {
  StakeBridgeOptions,
  BookAdapter,
  BookSegment,
  RoundContext,
  StakeRound,
  StakeUrlParams,
  ModeMap,
  AdapterModule,
  AdapterFactoryOptions,
  SegmentResult,
} from './types';
