# Publishing `@agreely/sdk` (npm)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Blocker before publish (must be filled)

1. **DEPLOY-GATED mainnet registry address.** Fill the ONE constant in
   `src/verify/receipt.ts`:

   ```ts
   const MAINNET_REGISTRY_ADDRESS: string | null = null; // <- deployed Base mainnet AgreelyRegistry address
   ```

   Leave it `null` and the on-chain `documentAnchor` check is reported
   `"skipped"` on mainnet (never a false pass/fail). Set it to the deployed
   AgreelyRegistry address, then rebuild (`npm run build`) so `dist/` matches.
   Base Sepolia (84532) stays available as an explicit opt-in for testing.

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
