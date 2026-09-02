# @beliq/sdk

Official Node/TypeScript SDK for the [beliq](https://beliq.eu) e-invoicing compliance API. Generate, validate, parse, and convert EN 16931 invoices (XRechnung, ZUGFeRD, Factur-X, Peppol BIS) against authority-pinned, nightly-drift-checked rules.

beliq produces and checks the compliant document. Transmission (Peppol, PDP, KSeF, SDI), archiving, and tax-authority reporting stay with your access point.

## Install

```bash
npm install @beliq/sdk
```

Requires Node >= 20.15. Ships ESM and CommonJS builds with bundled type declarations.

## Quick start

```ts
import { Beliq } from '@beliq/sdk';

const beliq = new Beliq({ apiKey: process.env.BELIQ_API_KEY! });

// Account, plan, and quota context (no quota cost).
const account = await beliq.me();

// Generate an XRechnung document from an EN 16931 invoice object.
const generated = await beliq.generate({
  standard: 'xrechnung',
  verify: true,
  invoice: {
    number: 'INV-2026-001',
    issueDate: '2026-01-15',
    currencyCode: 'EUR',
    seller: { name: 'Seller GmbH', address: { city: 'Berlin', postalCode: '10115', countryCode: 'DE' } },
    buyer: { name: 'Buyer GmbH', address: { city: 'Munich', postalCode: '80331', countryCode: 'DE' } },
    lines: [{ description: 'Consulting', quantity: 10, unitCode: 'HUR', unitPrice: 100, lineTotal: 1000, vatRate: 19, vatCategoryCode: 'S' }],
    totalNetAmount: 1000,
    totalTaxAmount: 190,
    totalGrossAmount: 1190,
  },
});
console.log(generated.xml, generated.meta.schematronVersion);

// Validate any document against authority-pinned rules.
const result = await beliq.validate(generated.xml!, { format: 'auto' });
if (!result.valid) {
  for (const issue of result.errors) console.log(issue.ruleId, issue.message);
}
```

## Authentication

Create an API key in the beliq dashboard under API Keys, then pass it to the client:

```ts
new Beliq({ apiKey: 'blq_live_...' });                 // sends X-API-Key (default)
new Beliq({ apiKey: 'blq_live_...', auth: 'bearer' });  // sends Authorization: Bearer
new Beliq({ apiKey: 'blq_live_...', baseUrl: 'https://staging.beliq.eu' });
```

Keys are prefixed `blq_live_` (production, draws your plan quota) or `blq_test_` (sandbox, separate free allowance, watermarked output). `client.livemode` reports the mode from the key prefix before any request; generate and convert results also carry the authoritative `meta.livemode` from the response.

```ts
const beliq = new Beliq({ apiKey: process.env.BELIQ_API_KEY! });
if (!beliq.livemode) console.warn('running against the sandbox');
```

## Timeouts and retries

The client retries transient failures for you, so you do not have to reimplement
backoff around it.

```ts
new Beliq({
  apiKey: 'blq_live_...',
  timeoutMs: 90_000,  // per-attempt deadline (default)
  maxRetries: 3,      // extra attempts after the first (default)
});
```

Both defaults are exported as `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_RETRIES`, so
you can derive from them instead of repeating the numbers.

Only `429`, `502` and `503` are retried, honouring the server's `Retry-After`
with jitter. beliq refunds the document's quota unit on a `503`, so a retry never
costs you a second document.

`504` and this client's own timeout are deliberately **not** retried: both mean
the work may still be running on beliq's side, so retrying risks producing a
second document rather than recovering the first.

A `429` carrying `QUOTA_EXCEEDED` is not retried either. `RATE_LIMITED` and
`ACCOUNT_THROTTLED` clear on their own, but a spent monthly allowance only returns
when your billing window turns, so the error is raised straight away and names the
cause instead of sleeping against it.

The default deadline is generous because beliq runs the full Schematron rule set
over each document, and a generate or validate can legitimately take tens of
seconds. If you lower it, keep it above the latency you actually see: a deadline
shorter than the server's own turns completed work into an unknown outcome. Set
`timeoutMs: 0` to disable it, and `maxRetries: 0` to handle retrying yourself.

## API

| Method | Endpoint | Input | Returns |
|---|---|---|---|
| `me()` | GET /v1/me | none | `AccountInfo` (no quota cost) |
| `generate(input)` | POST /v1/generate | EN 16931 invoice object | `{ contentType, bytes, xml?, sha256?, validationResult?, meta }` |
| `validate(document, options?)` | POST /v1/validate | XML or PDF | `ValidationResult` |
| `parse(document, options?)` | POST /v1/parse | XML or PDF | `ParseResult` |
| `convert(document, options)` | POST /v1/convert | XML or PDF | `{ contentType, bytes, meta }` |

`document` accepts a `string`, `Uint8Array`, `Buffer`, `ArrayBuffer`, or typed array. The content type is sniffed from the bytes (PDF vs XML) unless you pass `options.contentType`. `generate` and `convert` return raw document bytes plus the response-header metadata (`schematronVersion`, `pdfKind`, `sourceFormat`/`targetFormat`, `lostElements`, `conversionTools`, `livemode`); for an XML output, `generate` also decodes `xml`.

### Verify-it-yourself seal

Pass `seal: true` to `generate` to also get the document `sha256` and the full `validationResult`. Hashing the returned bytes reproduces the hash, so a recipient can check the document independently:

```ts
import { createHash } from 'node:crypto';

const doc = await beliq.generate({ standard: 'xrechnung', invoice, seal: true });
const ok = createHash('sha256').update(doc.bytes).digest('hex') === doc.sha256;
console.log(doc.validationResult?.valid, doc.meta.rulesetSha256, ok);
```

### Curated option lists

`LIVE_GENERATE_PRESETS` is the set of public generate targets beliq.eu itself offers, each mapping to the API `standard` (plus `profile`/`facturxProfile`) it needs. NLCIUS is a Peppol BIS profile and lives here rather than in `LIVE_GENERATE_STANDARDS`. Connectors build their dropdowns from these lists.

```ts
import { LIVE_GENERATE_PRESETS } from '@beliq/sdk';

const nlcius = LIVE_GENERATE_PRESETS.find((p) => p.id === 'nlcius');
await beliq.generate({ standard: nlcius!.standard, profile: nlcius!.profile, invoice });
```

Every option enum is typed from the OpenAPI spec, so wrong values fail at compile time. Errors throw `BeliqApiError` with a typed `.code`, HTTP `.status`, and any `.details`:

```ts
import { BeliqApiError } from '@beliq/sdk';

try {
  await beliq.validate('not xml');
} catch (err) {
  if (err instanceof BeliqApiError) console.log(err.code, err.status, err.message);
}
```

## Types stay in sync with the API

`src/generated/schema.ts` is generated from a vendored copy of the published OpenAPI spec (`openapi.json`).

```bash
npm run sync:spec      # refresh openapi.json from beliq-api / the live spec
npm run gen:types      # regenerate src/generated/schema.ts
npm run openapi:check  # CI drift guard: fails if the generated types are stale
```

The vendored spec is committed so builds are reproducible; nothing is fetched from the network at build time.

## Development

```bash
npm install
npm run build       # tsup: dual ESM + CJS + d.ts
npm run typecheck
npm run lint
npm test            # unit tests (no network)
BELIQ_API_KEY=blq_xxx npm run test:integration   # hits the live API; draws quota
```

## Publishing

Released to npm as [`@beliq/sdk`](https://www.npmjs.com/package/@beliq/sdk). Releases run from `.github/workflows/release.yml` via npm Trusted Publishing (OIDC, with provenance): push a `v*.*.*` tag to publish. No npm token is stored in the repo.

## License

MIT
