# @energy8platform/game-sdk

PostMessage-based bridge SDK for integrating HTML5 games into the Energy8 Platform.

Games run inside an iframe; **all backend communication goes through the host casino shell** via `window.postMessage`. The game never has direct access to API endpoints or player tokens.

> Running on Stake Engine? See [`@energy8platform/stake-bridge`](../stake-bridge) — a thick host wrapper that lets the same SDK-driven game run on Stake without changes.

## Installation

```bash
npm install @energy8platform/game-sdk
```

Or via CDN (UMD build):

```html
<script src="https://unpkg.com/@energy8platform/game-sdk/dist/casino-game-sdk.umd.js"></script>
<script>
  const sdk = new CasinoGameSDK();
</script>
```

## Quick Start

```ts
import { CasinoGameSDK } from '@energy8platform/game-sdk';

const sdk = new CasinoGameSDK();

// 1. Initialize — tells the host the game is loaded
const { balance, currency, config, session } = await sdk.ready();

// 2. Spin
const result = await sdk.play({ action: 'spin', bet: 1.0 });
console.log(result.data.matrix, result.totalWin);

// run animations, update UI...

// 2a. Acknowledge that the game has processed the result
sdk.playAck(result);

// 3. Free spins (if a session was started)
if (result.session && result.nextActions.includes('free_spin')) {
  let done = false;
  while (!done) {
    const fs = await sdk.play({
      action: 'free_spin',
      bet: 0,
      roundId: result.roundId,
    });
    // render free spin animation ...
    done = fs.session?.completed ?? true;
  }
}

// 4. Buy bonus
const bonus = await sdk.play({ action: 'buy_bonus', bet: 50 });
// bonus.session is now active, bonus.nextActions tells you what to do next

// 5. Pick bonus
const pick = await sdk.play({
  action: 'pick',
  bet: 0,
  roundId: bonus.roundId,
  params: { choice: 2 },
});
```

## API Reference

### `new CasinoGameSDK(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `parentOrigin` | `string` | auto (from `document.referrer`) | Expected origin of the host window. Set explicitly for stricter security. Use `'*'` only in development. |
| `timeout` | `number` | `15000` | Default timeout (ms) for request-response calls. |
| `debug` | `boolean` | `false` | Enable debug logging of all sent/received messages to the browser console. |
| `devMode` | `boolean` | `false` | Use the in-memory channel instead of `postMessage`. The host (e.g. `Bridge`, `StakeBridge`) must also be created with `devMode: true`. |

---

### `sdk.ready(): Promise<InitData>`

Signal to the host that the game is loaded. **Must be called once before any other method.**

Returns:

| Field | Type | Description |
|-------|------|-------------|
| `balance` | `number` | Player balance |
| `currency` | `string` | Player currency (`"USD"`, `"EUR"`, etc.) |
| `config` | `GameConfigData` | Full game configuration (symbols, paylines, bet levels, jurisdiction flags, …) |
| `session` | `SessionData \| null` | Active session to resume (e.g. interrupted free spins), or `null` |
| `assetsUrl` | `string \| undefined` | Base URL for game assets in S3 |
| `lang` | `string \| undefined` | ISO 639-1 language code passed by the operator |
| `device` | `'desktop' \| 'mobile' \| undefined` | Device hint passed by the operator |

---

### `sdk.play(params): Promise<PlayResultData>`

Execute any game action: spin, free spin, buy bonus, pick, etc. This is the **single universal method** for all game interactions.

**Parameters (`PlayParams`):**

| Field | Type | Description |
|-------|------|-------------|
| `action` | `string` | Action to execute: `"spin"`, `"free_spin"`, `"buy_bonus"`, `"pick"`, etc. |
| `bet` | `number` | Total bet amount (use `0` for session-based actions like free spins) |
| `roundId` | `string \| undefined` | *(optional)* Round ID for session-based actions |
| `params` | `Record<string, unknown>` | *(optional)* Game-specific parameters: `choice`, `lines`, `ante_bet`, etc. |

**Returns (`PlayResultData`):**

| Field | Type | Description |
|-------|------|-------------|
| `roundId` | `string` | Unique game round ID |
| `action` | `string` | Action that was executed |
| `balanceAfter` | `number` | Player balance after the action |
| `totalWin` | `number` | Total win amount |
| `currency` | `string` | Player currency |
| `gameId` | `string` | Game identifier |
| `data` | `Record<string, unknown>` | Game-specific output (matrix, win_lines, multiplier, etc.) |
| `nextActions` | `string[]` | Actions the client can invoke next (e.g. `["free_spin"]`, `["spin"]`) |
| `session` | `SessionData \| null` | Active session state, or `null` if no session / session completed |
| `creditPending` | `boolean \| undefined` | `true` if win credit was deferred (server-side retry in progress) |
| `bonusFreeSpin` | `BonusFreeSpin \| null \| undefined` | Bonus free spin grant info (`grantId`, `remainingSpins`), if applicable |

**Errors:** `INSUFFICIENT_FUNDS`, `ACTIVE_SESSION_EXISTS`, `NO_ACTIVE_SESSION`, `SESSION_COMPLETED`, `TIMEOUT`

---

### `sdk.playAck(result, id?): void`

Signal to the host that the game has **fully processed** a `PLAY_RESULT` — animations finished, UI updated, player can interact again.

Call this after `sdk.play()` resolves and all client-side processing is complete.

```ts
const result = await sdk.play({ action: 'spin', bet: 1.0 });
await runWinAnimations(result);
sdk.playAck(result); // host now knows the client is ready for the next action
```

---

### Other methods

- `sdk.getBalance(): Promise<BalanceData>` — fetch current balance from the host.
- `sdk.getState(): Promise<PlayResultData | null>` — query the active game session (e.g. after page reload).
- `sdk.openDeposit(): void` — ask the host to open the deposit / cashier UI. Fire-and-forget.
- `sdk.destroy(): void` — clean up listeners and reject pending requests.

### Events

```ts
sdk.on('balanceUpdate', ({ balance }) => updateBalanceUI(balance));
sdk.on('error', (err) => console.error(err.code, err.message));
sdk.off('balanceUpdate', handler);
```

### State Getters

| Getter | Type | Description |
|--------|------|-------------|
| `sdk.balance` | `number` | Current player balance |
| `sdk.currency` | `string` | Player currency |
| `sdk.config` | `GameConfigData \| null` | Game configuration from init |
| `sdk.session` | `SessionData \| null` | Active session, or `null` |

## Key Types

### `SessionData`

Represents an active game session (free spins, bonus rounds, etc.):

| Field | Type | Description |
|-------|------|-------------|
| `spinsRemaining` | `number` | Remaining session actions |
| `spinsPlayed` | `number` | Actions already played |
| `totalWin` | `number` | Cumulative session win |
| `completed` | `boolean` | Whether the session has finished |
| `maxWinReached` | `boolean` | Whether the max win cap was hit |
| `betAmount` | `number \| undefined` | Last bet amount |
| `history` | `Array<{ spinIndex, win, data }>` | Round history within the session |

### `JurisdictionFlags` (operator-driven)

Optional `config.jurisdiction` exposes operator-required toggles such as `disabledTurbo`, `disabledAutoplay`, `displayRTP`, `minimumRoundDuration`. Field is absent on platforms that don't supply jurisdictions.

```ts
const { config } = await sdk.ready();
if (config.jurisdiction?.disabledTurbo) hideTurboButton();
if (config.jurisdiction?.displayRTP) showRtpBadge();
```

## Protocol Sub-export

For host-side integration or advanced use cases, import the raw protocol types:

```ts
import { isBridgeMessage, createMessage } from '@energy8platform/game-sdk/protocol';
import type {
  BridgeMessage,
  PlayResultPayload,
  PlayResultAckPayload,
} from '@energy8platform/game-sdk/protocol';
```

## Error Types

| Class | Code | When |
|-------|------|------|
| `SDKError` | varies | Base error class. `err.code` contains the error code. |
| `TimeoutError` | `TIMEOUT` | Host did not respond within the timeout period. |
| `BridgeNotReadyError` | `BRIDGE_NOT_READY` | Method called before `sdk.ready()`. |
| `BridgeDestroyedError` | `BRIDGE_DESTROYED` | Method called after `sdk.destroy()`. |

## Host Integration (`Bridge`)

The SDK also exports a `Bridge` class for the **host (casino shell)** side. It handles postMessage communication with the game iframe.

```ts
import { Bridge } from '@energy8platform/game-sdk';
import type {
  PlayRequestPayload,
  PlayResultAckPayload,
  InitPayload,
} from '@energy8platform/game-sdk';

const iframe = document.getElementById('game') as HTMLIFrameElement;
const bridge = new Bridge({ iframe, targetOrigin: '*' });

bridge.on<undefined>('GAME_READY', (_payload, id) => {
  const initData: InitPayload = {
    balance: 1000,
    currency: 'USD',
    config: { id: 'my-slot', type: 'slot', betLevels: [1, 5, 10] },
    session: null,
  };
  bridge.send('INIT', initData, id);
});

bridge.on<PlayRequestPayload>('PLAY_REQUEST', async (payload, id) => {
  try {
    const result = await yourBackend.play(payload);
    bridge.send('PLAY_RESULT', result, id);
  } catch (err) {
    bridge.send('PLAY_ERROR', { code: 'INTERNAL', message: String(err) }, id);
  }
});

bridge.on('GET_BALANCE', (_payload, id) => {
  bridge.send('BALANCE_UPDATE', { balance: getCurrentBalance() }, id);
});

bridge.on('GET_STATE', (_payload, id) => {
  bridge.send('STATE_RESPONSE', { session: getLastPlayResult() }, id);
});

bridge.on('OPEN_DEPOSIT', () => openDepositModal());

bridge.on<PlayResultAckPayload>('PLAY_RESULT_ACK', (payload) => {
  console.log(`Game processed round ${payload.roundId}, win: ${payload.totalWin}`);
});

bridge.send('BALANCE_UPDATE', { balance: 1500 });

bridge.destroy();
```

### `new Bridge(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `iframe` | `HTMLIFrameElement` | *(required unless `devMode`)* | The game iframe element |
| `targetOrigin` | `string` | `'*'` | Target origin for `postMessage`. Set to the game's origin in production. |
| `debug` | `boolean` | `false` | Enable debug logging of all sent/received messages to the browser console. |
| `devMode` | `boolean` | `false` | Use the in-memory channel (same window, no iframe). |

### Bridge Methods

| Method | Description |
|--------|-------------|
| `bridge.on(type, handler)` | Subscribe to a message type from the game |
| `bridge.off(type, handler)` | Unsubscribe a handler |
| `bridge.send(type, payload, id?)` | Send a message to the game |
| `bridge.destroy()` | Remove all listeners and clean up |

## Architecture

```
┌─────────────────────────────────────┐
│  Host (Casino Shell)                │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  <iframe src="game.html">     │  │
│  │                               │  │
│  │  Game code + CasinoGameSDK    │  │
│  │         │                     │  │
│  │         │ postMessage         │  │
│  └─────────┼─────────────────────┘  │
│            │                        │
│    Bridge (host-side class)         │
│            │                        │
│    Backend API (play, wallet, …)    │
└─────────────────────────────────────┘
```

## License

MIT
