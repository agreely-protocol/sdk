# Publishing `agreely/sdk` (Packagist)

First public release: `0.1.0`. This package is MAINNET-bound: the verifier
defaults to Base mainnet (chainId 8453).

## Blocker before publish (must be filled)

1. **DEPLOY-GATED mainnet registry address.** Fill the ONE constant in
   `src/Verify/ReceiptVerifier.php`:

   ```php
   private const MAINNET_REGISTRY_ADDRESS = null; // <- deployed Base mainnet AgreelyRegistry address
   ```

   Leave it `null` and the on-chain `documentAnchor` check is reported
   `"skipped"` on mainnet (never a false pass/fail). Set it to the deployed
   AgreelyRegistry address. Base Sepolia (84532) stays available as an explicit
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
