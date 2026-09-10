# Model catalogs

The website repository maintains and publishes the remote catalog through a manually triggered
GitHub Actions workflow. This desktop repository owns the bundled baseline, consumer contract,
trusted public keys, and local model configuration.

## Desktop behavior

The system catalog combines the bundled baseline with a verified remote snapshot. Saved local
definitions overlay that system catalog for configured models. The model picker reads the system
view, so local renames, wire IDs, limits, and custom definitions do not change its suggestions.

The application restores its verified cache without a network request, starts its first background
check after five seconds, and checks again six hours after each completed attempt. Fetches omit
credentials. The default origin is `https://www.piskie.dev`; `PISKIE_MODEL_CATALOG_BASE_URL` can override
it with HTTPS or a localhost HTTP origin for development.

Updates require a valid Ed25519 signature, exact SHA-256 hash, supported client version and drivers,
and valid model definitions. A newer bundled baseline takes precedence over an older remote snapshot.
The cache retains its current and previous complete snapshots. Download or verification failures
leave existing models usable, and running inference snapshots remain stable.

## Bundled baseline

The local development commands remain available when preparing a desktop release:

```bash
npm run catalog:sync
npm run catalog:validate
```

Review provider changes and generated output before committing. Missing upstream models are retained
as retired definitions so existing references continue to resolve. Website publication is independent
of these commands and does not require an action in this repository.

## Consumer contract

`electron/inference/catalog/distribution.ts` defines the v1 manifest, signature payload, and verification.
`electron/inference/catalog/contracts.ts` defines the catalog document schema. The website publisher
keeps a JSON Schema snapshot of that contract. Coordinate schema and driver changes with its minimum
client version before publishing newly supported data.

`trusted-keys.json` contains public keys only. Introduce a new public key in compatible clients before
switching the website signing key; retain the old public key while its signed caches remain supported.
