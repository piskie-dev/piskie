# Model catalogs

The website repository (`piskie-site`) owns model sourcing, validation, signing, and publication of the
remote catalog through its manually triggered **Update model catalog** GitHub Actions workflow. This
desktop repository owns the consumer contract, the trusted public keys, the local model configuration,
and a bundled snapshot of that publication.

## Bundled baseline

`generated/catalog.json` holds the exact bytes of one published catalog object and
`generated/manifest.json` holds its signed manifest, so the same Ed25519 signature and SHA-256 hash
protect the website publication and the desktop build. There is no separate desktop sync; both sides
share one baseline.

```bash
npm run catalog:pull       # fetch and verify the current publication into generated/
npm run catalog:validate   # re-verify the checked-in snapshot offline
```

Run `catalog:pull` before tagging a desktop release, review the printed added, removed, and changed
model IDs, and commit the two generated files. `PISKIE_MODEL_CATALOG_BASE_URL` can point the pull at
a preview or localhost origin. A publication older than the bundled revision is rejected.

## Desktop behavior

The system catalog combines the bundled baseline with a verified remote snapshot. Saved local
definitions overlay that system catalog for configured models. The model picker reads the system
view, so local renames, wire IDs, limits, and custom definitions do not change its suggestions.

The application restores its verified cache without a network request, starts its first background
check after five seconds, and checks again six hours after each completed attempt. Fetches omit
credentials. The default origin is `https://www.piskie.dev`; `PISKIE_MODEL_CATALOG_BASE_URL` can override
it with HTTPS or a localhost HTTP origin for development.

Updates require a valid Ed25519 signature, exact SHA-256 hash, supported client version and drivers,
and valid model definitions. A publication whose hash matches the bundled snapshot is not downloaded,
and a newer bundled baseline takes precedence over an older remote snapshot. The cache retains its
current and previous complete snapshots. Download or verification failures leave existing models
usable, and running inference snapshots remain stable.

## Consumer contract

`electron/inference/catalog/distribution.ts` defines the v1 manifest, signature payload, and verification.
`electron/inference/catalog/contracts.ts` defines the catalog document schema. The website publisher
keeps a JSON Schema snapshot of that contract. Coordinate schema and driver changes with its minimum
client version before publishing newly supported data.

`trusted-keys.json` contains public keys only. Introduce a new public key in compatible clients before
switching the website signing key; retain the old public key while its signed caches remain supported.
