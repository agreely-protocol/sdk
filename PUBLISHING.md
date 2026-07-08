# Publishing `@agreely/sdk` (npm)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Mainnet registry address (DONE)

1. **Mainnet registry address is deployed, verified, and filled.** The ONE
   constant in `src/verify/receipt.ts` now holds the live Base mainnet
   AgreelyRegistry:

   ```ts
   const MAINNET_REGISTRY_ADDRESS: string | null = "0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B";
   ```

   The AgreelyRegistry is deployed and verified on Base mainnet (chainId 8453)
   at `0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B` (deploy block 48323919). The
   on-chain `documentAnchor` check now resolves this address by default and
   performs the lookup. `dist/` has been rebuilt to carry the address. Base
   Sepolia (84532) stays available as an explicit opt-in for testing.

## Publish steps

```sh
npm ci
npm run build          # regenerates dist/ (ESM + CJS + .d.ts)
npm test               # unit suite must be green
npm publish --access public
```

Notes:
- The `@agreely` npm org must exist and be owned by the publisher. `@agreely`
  is a **scoped** package; `publishConfig.access` is set to `public`, and
  `--access public` is passed explicitly.
- `files` ships `dist`, `README.md`, and `LICENSE` only. No `src`, tests, or
  scratch is published.
- Keep the version at `0.1.0`. Do not create a git tag here; the human tags at
  publish time.
