# Local browser operations fixture

This is a standalone Node 24 HTTP site and native ESM frontend. It uses Node built-ins only, serves all assets locally, and binds only to `127.0.0.1`, `::1`, or `localhost`. Starting it does not touch or restart the application. All people, companies, documents, orders and quantities are fictional.

The CLI, reporting and model runners live alongside this directory. This directory owns the business site and its independent result oracle.

## Files and runner contract

- `server.mjs`: `await startFixtureServer({host = '127.0.0.1', port = 0, seed = 1})` returns `{baseUrl, createRun, getRun, evaluateRun, close}`. `close()` is asynchronous and idempotent.
- `scenarios.mjs`: `SUITE_ID = 'browser-operations'`, `SUITE_VERSION = '1'`, and eight scenario definitions with `{id,title,description,capabilities,task}`. Metadata tasks contain `{{url}}` and, where needed, `{{attachmentPath}}`; `createRun` resolves both.
- `model.mjs`: validated business inputs, seeded stock and the sole owner of in-memory business records.
- `oracle.mjs`: checks stored business records, their field values, attachments, stock changes and unaffected entities. It does not use model claims or tool return statuses.
- `web/`: responsive operations UI with labels, live status and error feedback, keyboard controls, same-origin iframes and an open shadow component.
- `data/parcel-note.txt`: permanent synthetic upload document; its actual bytes and SHA-256 are checked after dispatch.
- `smoke.mjs`: reusable Puppeteer UI exercises for all scenarios.

`createRun({scenarioId, seed = 1})` returns `{runId,scenarioId,seed,url,task,createdAt}`. Run IDs use `crypto.randomUUID()`. The seed controls data and service delays; it does not control run IDs or timestamps. Each run starts with its own business state, including the journey. The server option validates the suite seed; each creation call specifies its run seed (default `1`).

`getRun(runId)` returns a detached copy of `{runId,scenarioId,seed,createdAt,updatedAt,state,events}`. `evaluateRun(runId)` returns `{status:'passed'|'failed',checks:[{id,passed,expected,actual}],completedAt}`. Reading an oracle does not change the run. A run with no completed business work fails.

| HTTP endpoint | Purpose |
| --- | --- |
| `GET /api/scenarios` | `{suiteId,suiteVersion,scenarios}` metadata |
| `POST /api/runs` | JSON `{scenarioId,seed?}`; returns the created run with status 201 |
| `GET /api/runs/:runId` | Runner state and event evidence |
| `GET /api/runs/:runId/result` | Runner oracle; incomplete and failed work returns a failed verdict with HTTP 200 |
| `GET /api/runs/:runId/workspace` | Business state for the UI |
| `POST /api/runs/:runId/actions` | Strict JSON business actions |
| `GET /api/runs/:runId/inventory` | Filtered, paginated business stock reads |
| `GET /api/runs/:runId/routes` | Embedded routing settings |
| `GET /api/runs/:runId/connector` | Real local 503/200 health responses with console evidence from the UI |
| `GET /api/runs/:runId/scan/:scanId` | Delayed scan result; cancellation remains authoritative |

HTTP mutation bodies reject unknown fields and invalid values before changing records. The service also checks entity existence, stock availability, seal equality and workflow prerequisites. Invalid transport or fields return 400/413/415, missing records return 404, disallowed business sections return 403, and workflow conflicts return 409. Host and Origin checks keep browser requests on the bound local origin. No external resource or analytics requests are made.

## Coverage and business results

| Scenario | UI work | Independent result |
| --- | --- | --- |
| `intake` | Text, date and numeric fields; select; radio; independent checkboxes; delayed receipt navigation | One submitted request with every required value and preference |
| `inventory` | Filter, paginate, inspect a long movement ledger, refresh and replace stock DOM, reserve a specific row | Correct SKU/customer/quantity, prior refreshed filtered view, exact stock delta, other stock unchanged |
| `approvals` | Hover note, contextual menu, native confirm cancellation, prompt and alert | Cancel recorded, one approved target with correct finance reason, other request pending |
| `board` | Real parcel drag, file selection and upload, second drag to dispatch | Packed then dispatched parcel, correct document name/bytes/digest, linked dispatch, other parcels untouched |
| `frames` | Two nested same-origin frames, open shadow editor, save and remount | Correct route fields and a subsequent read of saved values; other route untouched |
| `tabs` | New receiving window, form submission, close and original-page refresh/reconciliation | One correct receiving record and reconciliation, other purchase order untouched |
| `diagnostics` | Actual failed network request and console error, delayed scan cancellation, route repair, retry, incident resolution | Original error/trace evidence, cancelled scan, ready connector, correct incident note |
| `journey` | Independent intake → stock → dispatch/upload → receiving/window sequence, final order | All four component business checks plus a single correctly linked final order and event sequence |

The journey never reuses a single-scenario run. Counts in the oracle represent business records (one request, one reservation, one receiving confirmation), not limits on browser operations or retries. Save corrections, page inspection, navigation and refreshes are not assigned an arbitrary operation cap.

The inventory refresh replaces result nodes while keeping SKU identities and form IDs stable, and changes adjacent row ordering. Browser-generated UID stability is exercised by runners against that page; the site does not invent a browser UID. The movement ledger supplies a long, realistic accessibility/text snapshot. The board also has a keyboard Move control, while the smoke explicitly uses a real pointer drag.

## UI smoke and validation

`await runFixtureSmoke({baseUrl, browser, artifactDir, scenarioIds?, seed?, allowMissingConsole?})` takes an already connected Puppeteer 25 browser and an absolute temporary artifact directory. It returns an array of `{run,result,startedAt,endedAt,wallTimeMs,error?,artifacts,capabilityNotes}`. `scenarioIds` defaults to all eight IDs; `seed` defaults to 1. It opens a fresh browser context per scenario at 1440 × 1000 pixels (device scale factor 1), continues after a scenario failure, writes screenshots and console/network observations under the supplied directory, and closes its contexts. The caller owns the browser and fixture server lifecycle.

The smoke fills the actual controls, handles native dialogs, drags DOM elements with Puppeteer, selects the actual file, traverses frames/shadow DOM and submits the popup form. Its only direct runner HTTP writes create new runs. Final verdicts are fetched from the HTTP oracle. Page evaluation is limited to read-only waiting and visible field inspection; it never writes business state or substitutes a fetch for a form submission.

`allowMissingConsole` defaults to false. When explicitly enabled for a fingerprint browser that does not emit console events, diagnostics still completes and verifies the network evidence and all business checks, and records a console `unavailable` capability note. It never claims that the missing console evidence was observed.

The smoke is a deterministic UI integration check, not a model performance measurement. Its wall time begins before run creation and includes browser setup, UI work and the final oracle read; it ends before screenshots, observation-file writes and context cleanup. Artifact or cleanup failures are still reported in `error`. This time must not be reported as a model's tokens/second or model step count. Real model timing and token collection belong to the model runner.

Run business/oracle tests with:

```sh
node --test benchmarks/browser/tests/fixture-server.test.mjs
```

The tests exercise all eight successful business outcomes, incomplete runs, wrong values/entities, forged upload contents, duplicate records, concurrent stock reservations, cancellation races, invalid public inputs, deterministic seeds, isolated runs and service lifecycle. The coordinating runner performs real Chromium smoke and current-browser-tool coverage separately.

Runs and files are held in memory until server shutdown; this fixture is intentionally local and ephemeral. The two embedded frames are same-origin, the shadow root is open, and the uploaded document is UTF-8 text limited to 16 KiB. These are the supported test boundaries, not coverage of arbitrary cross-origin sites, closed shadow roots or large binary transfers.
