# Publishing `@agreely/sdk` (npm)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Mainnet registry address (RE-CHECK EVERY RELEASE)

1. **The known registry addresses must match the LIVE deployments.** The map is
   `REGISTRY_BY_CHAIN` in `src/verify/receipt.ts`. The live Base mainnet (chainId
   8453) AgreelyRegistry is `0x6F2cF94045cF0cbDD94338882c34D183575023E9`, deploy
   block 53113531. Base Sepolia (84532) is `0xf25D3F8E73648C797Be2CCCD428061f357567b9A`,
   deploy block 50213158, and stays an explicit opt-in for testing.

2. **VERIFY IT BEFORE EVERY PUBLISH.** This is pinned BY HAND: the SDK reads no
   config, and the app resolves its own address from `config/anchor-network.json`
   plus the `BASE_REGISTRY_ADDRESS` secret, so a registry redeploy does NOT
   propagate here. A superseded contract still exists on chain and still answers
   `eth_call`, but it holds none of the new anchors, so the anchor checks read
   `unavailable` on valid receipts.

   Two independent sources of truth, both cheap to check:

   ```sh
   # 1. the deploy artefact
   jq -r '.transactions[0].contractAddress' \
     ../agreely-contracts/broadcast/DeployRegistry.s.sol/8453/run-latest.json

   # 2. what the live verifier publishes
   curl -s https://app.agreely.ca/verify | grep -o 'registryAddress"[^,}]*'
   ```

   Both must equal the Base mainnet address, case-insensitively. The test suite pins the
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
- `files` ships `dist`, `README.md`, `CHANGELOG.md` and `LICENSE` only. No `src`,
  tests, or scratch is published.
- Publish the version `package.json` carries; its CHANGELOG entry must exist. Do not
  create a git tag here; the human tags at publish time.
- Optional, against a local stack: `AGREELY_LIVE=1 npm run test:contract` with a
  fixture seeded into `test/contract/fixture.json` (set `AGREELY_APP_DIR` to the API
  stack's directory to include the out-of-band revoke step).
