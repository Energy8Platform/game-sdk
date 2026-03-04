/**
 * @casino-platform/game-sdk
 *
 * Unified SDK for integrating HTML5 games with the Casino Platform.
 * Games run inside an iframe; all API communication goes through the
 * host casino shell via postMessage.
 */

// Main SDK class
export { CasinoGameSDK } from './sdk';

// Protocol (useful for host-side integration or advanced use cases)
export {
  isBridgeMessage,
  createMessage,
  type BridgeMessage,
  type BridgeMessageType,
  type GuestMessageType,
  type HostMessageType,
  type GameReadyPayload,
  type PlayRequestPayload,
  type PlayResultPayload,
  type PlayResultAckPayload,
  type PlayErrorPayload,
  type GetBalancePayload,
  type GetStatePayload,
  type OpenDepositPayload,
  type InitPayload,
  type BalanceUpdatePayload,
  type StateResponsePayload,
  type ErrorPayload,
  type WinLineData,
  type AnywhereWinData,
  type GameConfigData,
  type SymbolData,
  type PaylineData,
  type SessionData,
} from './protocol';

// Public types
export type {
  CasinoGameSDKOptions,
  InitData,
  PlayParams,
  PlayResultData,
  BalanceData,
  WinLine,
  AnywhereWin,
  GameConfig,
  SymbolInfo,
  PaylineInfo,
  SessionState,
} from './types';

// Errors
export { SDKError, TimeoutError, BridgeNotReadyError, BridgeDestroyedError } from './errors';

// Transport (for advanced or testing use cases)
export { PostMessageTransport, type TransportOptions } from './transport';

// Host-side bridge
export { Bridge, type BridgeOptions, type MessageHandler } from './bridge';
