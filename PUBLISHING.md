# Publishing `@agreely/sdk` (npm)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Mainnet registry address (RE-CHECK EVERY RELEASE)

1. **The pinned mainnet registry address must match the LIVE deployment.** The ONE
   constant in `src/verify/receipt.ts` holds it:

   ```ts
   const MAINNET_REGISTRY_ADDRESS: string | null = "0x23577fafFa306375028D33a559D0F95Ced9424DB";
   ```

   Live Base mainnet (chainId 8453) AgreelyRegistry: `0x23577fafFa306375028D33a559D0F95Ced9424DB`, deploy block
   48889369 (the 2026-07-19 redeploy carrying the DID-tagged anchor events).
   EIP-55 checksummed. Base Sepolia (84532) stays available as an explicit opt-in
   for testing.

2. **VERIFY IT BEFORE EVERY PUBLISH.** This is pinned BY HAND: the SDK reads no
   config, and the app resolves its own address from `config/anchor-network.json`
   plus the `BASE_REGISTRY_ADDRESS` secret, so a registry redeploy does NOT
   propagate here. A stale address is SILENT and worse than a missing one: the
   superseded contract still exists on chain and still answers `eth_getLogs`, it
   just holds no anchors, so every `documentAnchor` check returns `"fail"`, which
   reads as TAMPERING on a perfectly valid receipt. v0.2.0 shipped exactly that,
   pinned to the predecessor `0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B`.

   Two independent sources of truth, both cheap to check:

   ```sh
   # 1. the deploy artefact
   jq -r '.transactions[0].contractAddress' \
     ../agreely-contracts/broadcast/DeployRegistry.s.sol/8453/run-latest.json

   # 2. what the live verifier publishes
   curl -s https://verify.agreely.ca/ | grep -o 'registryAddress"[^,}]*'
   ```

   Both must equal the constant, case-insensitively. The test suite pins the
   value, so a silent edit fails a test, but only THIS step catches a redeploy
   that the tests do not know about yet.

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
