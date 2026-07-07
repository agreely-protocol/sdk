# Publishing `agreely/sdk` (Packagist)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Mainnet registry address (DONE)

1. **Mainnet registry address is deployed, verified, and filled.** The ONE
   constant in `src/Verify/ReceiptVerifier.php` now holds the live Base mainnet
   AgreelyRegistry:

   ```php
   private const MAINNET_REGISTRY_ADDRESS = '0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B';
   ```

   The AgreelyRegistry is deployed and verified on Base mainnet (chainId 8453)
   at `0x1E3121CFB5dfE1ac0b0265790D2bdA709725cF8B` (deploy block 48323919). The
   on-chain `documentAnchor` check now resolves this address by default and
   performs the lookup. Base Sepolia (84532) stays available as an explicit
   opt-in for testing (pass `chainId => 84532`).

## Publish steps

There is no build step. Packagist reads a git tag.

```sh
composer test          # unit suite must be green
```

1. Push this repo to its public GitHub URL.
2. Submit the repo URL at https://packagist.org/packages/submit (one time),
   or rely on the GitHub webhook for later updates.
3. **Packagist reads a `v0.1.0` git tag** as the released version. The human
   creates and pushes that tag at publish time.

Notes:
- `composer.json` name is `agreely/sdk`, license `MIT`.
- Keep the version at `0.1.0` (via the `v0.1.0` tag). Do not create the tag
  here; the human tags at publish time.
