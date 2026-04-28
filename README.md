# Energy8 Platform Game SDK — monorepo

This monorepo contains the building blocks for HTML5 casino game integration on Energy8 and (optionally) Stake Engine.

## Packages

| Package | Path | Description |
|---|---|---|
| [`@energy8platform/game-sdk`](./packages/game-sdk) | `packages/game-sdk` | Core SDK: postMessage / in-memory bridge between an HTML5 game (guest) and the casino shell (host). |
| [`@energy8platform/stake-bridge`](./packages/stake-bridge) | `packages/stake-bridge` | Drop-in host wrapper that lets a game written against `game-sdk` run on [Stake Engine](https://stake-engine.com/docs) without modification. |

`stake-bridge` peer-depends on `game-sdk` — it reuses `Bridge`, `MemoryChannel`, and the protocol types instead of duplicating them.

## Layout

```
.
├── package.json              # workspaces + hoisted devDependencies
├── tsconfig.base.json        # shared TS config; each package extends it
└── packages/
    ├── game-sdk/
    └── stake-bridge/
```

## Scripts (run at the repo root)

```bash
npm install            # install + symlink workspaces
npm run build          # build game-sdk first, then stake-bridge
npm run build:sdk      # game-sdk only
npm run build:stake    # stake-bridge only (requires game-sdk dist)
npm run typecheck      # tsc --noEmit across both packages
npm run clean          # remove all dist/
```

`stake-bridge` is built **after** `game-sdk` because it imports the published types from `@energy8platform/game-sdk`. The default `npm run build` already runs them in the right order.

## License

MIT
