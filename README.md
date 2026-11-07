# @beliq/sdk

Official Node/TypeScript SDK for the [beliq](https://beliq.eu) API: validate, generate, convert and parse EU e-invoices (XRechnung, ZUGFeRD, Factur-X, Peppol BIS) from Node.js. A validation result names the rule pack that judged the document, its version and, in `verificationBadgeLabel` when the API states one, how deep the check went. [How verification works](https://docs.beliq.eu/compliance/how-verification-works/) explains each depth.

beliq produces and checks the document. Transmission (Peppol, plateforme agréée, KSeF, SDI), archiving, and tax-authority reporting stay with your access point.

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
  // The XRechnung CIUS asks for more than plain EN 16931: a seller contact
  // (BR-DE-2), payment instructions (BR-DE-1), a VAT breakdown (BR-CO-18) and an
  // electronic address for each party. examples/invoice.json is this same shape.
  invoice: {
    number: 'INV-2026-001',
    issueDate: '2026-01-15',
    currencyCode: 'EUR',
    buyerReference: '04011000-12345-06',
    seller: {
      name: 'Seller GmbH',
      vatId: 'DE123456789',
      contactName: 'Anna Muster',
      email: 'billing@seller.example',
      phone: '+49 30 1234567',
      address: { street: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE' },
      peppol: { schemeId: '9930', id: 'DE123456789' },
    },
    buyer: {
      name: 'Buyer GmbH',
      vatId: 'DE987654321',
      email: 'ap@buyer.example',
      address: { street: 'Marktweg 2', city: 'Munich', postalCode: '80331', countryCode: 'DE' },
      peppol: { schemeId: '9930', id: 'DE987654321' },
    },
    lines: [{ description: 'Consulting', quantity: 10, unitCode: 'HUR', unitPrice: 100, lineTotal: 1000, vatRate: 19, vatCategoryCode: 'S' }],
    taxSummary: [{ vatCategoryCode: 'S', vatRate: 19, taxableAmount: 1000, taxAmount: 190 }],
    paymentMeans: { typeCode: '58', iban: 'DE89370400440532013000' },
    totalNetAmount: 1000,
    totalTaxAmount: 190,
    totalGrossAmount: 1190,
  },
});
console.log(generated.xml, generated.meta.schematronVersion);

// Validate a document. The result names the rules that ran and, when the API states one, the check depth.
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
  timeoutMs: 90_000,       // per-attempt deadline (default)
  retryBudgetMs: 900_000,  // how long to keep retrying an outage: 15 minutes (default)
});
```

Leave `maxRetries` unset unless you want to bound every retry: unset, it allows 3
retries of the failures retried by count and leaves the budget's failures to the
budget, while any number you pass, `DEFAULT_MAX_RETRIES` included, bounds them
all.

The defaults are exported as `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY_BUDGET_MS` and
`DEFAULT_MAX_RETRIES`, so you can derive from them instead of repeating the
numbers.

| Failure | Retried |
|---|---|
| `503` `DATABASE_UNAVAILABLE` | until the budget is spent |
| `502` or `503` with no beliq error code, which a proxy in front of the API sends | until the budget is spent |
| A connection that could not be opened: a `cause.code` of `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH` or `UND_ERR_CONNECT_TIMEOUT` | until the budget is spent |
| `429` `RATE_LIMITED` or `ACCOUNT_THROTTLED` | up to `maxRetries` times |
| `503` `ENGINE_UNAVAILABLE`, and any other `502` or `503` with a beliq error code | up to `maxRetries` times |
| Any other thrown error, such as a connection lost after the request was sent | up to `maxRetries` times |
| `429` `QUOTA_EXCEEDED`, `504`, this client's own timeout, and every other status | never |

Every wait follows the server's `Retry-After` in full, plus up to 250 ms of
jitter. Without one, the client backs off exponentially from 500 ms with jitter,
and no wait reaches 30 s. No attempt starts after the budget, so a `Retry-After`
longer than the time left ends the call at once with that error, and an outage
longer than the budget ends it with the last error. A call that meets an outage
can therefore take up to 15 minutes to return, plus the last attempt's own
deadline of up to `timeoutMs`. A host name that does not resolve counts as an
outage too, so a misspelt `baseUrl` takes the whole budget to fail. Where your
code cannot wait that long, such as inside a request with a time limit of its
own, pass a shorter `retryBudgetMs`. The 15 minutes are beliq's own choice, not
a standard's: they outlast two of the three database outages beliq has
measured, of about 9 and 12 minutes. The third lasted 33 minutes, and a call
that meets one like it ends with the last error.

`maxRetries: 0` turns retrying off, and so does `retryBudgetMs: 0`.

What a retry costs:

- Most `DATABASE_UNAVAILABLE` answers come before any quota unit is spent, and a
  retry of one of those costs nothing. When the request had spent a unit, beliq
  tries to refund it at once and says on the `x-beliq-quota-refunded` header
  whether that worked. While the database is out, the refund usually cannot be
  applied; https://docs.beliq.eu/api-reference/errors/ says how such a unit is
  reconciled.
- The unit of an `ENGINE_UNAVAILABLE` is refunded, within the cap that page
  names.
- A test key's sandbox units are never refunded.
- A connection lost after the request was sent can mean beliq already ran the
  request and charged it. beliq does not charge a repeat of a charged
  `generate`, `validate`, `parse` or `convert` request again within 15 minutes
  of the charge, up to 10 repeats, and every retry sends the same request. The
  answer to such a repeat carries `x-beliq-idempotent-replay: true`. A
  `maxRetries` above 10 can be charged again. When beliq cannot read or write
  its record of charged requests, it charges every attempt.
  https://docs.beliq.eu/api-reference/errors/#repeated-requests-are-not-charged-again
  says what makes two requests the same.

`504` and this client's own timeout are deliberately **not** retried: both can
mean the work is still running on beliq's side, and a retry runs the same
document again from the start, so it would likely run out of time again.

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

`document` accepts a `string`, `Uint8Array`, `Buffer`, `ArrayBuffer`, or typed array. The content type is sniffed from the bytes (PDF vs XML) unless you pass `options.contentType`. `generate` and `convert` return raw document bytes plus the response-header metadata (`schematronVersion`, `pdfKind`, `sourceFormat`/`targetFormat`, `lostElements`, `conversionTools`, `livemode`); for an XML output, `generate` also decodes `xml`. Each entry of `lostElements` is a `LostElement` as https://docs.beliq.eu/api-reference/convert/#lostelement-schema describes it, except past the API's 6 KB header cap, where the list holds one `{ truncated: true, reason }` entry instead and `lostElementsCount` stays the exact count.

### Verify-it-yourself seal

Pass `seal: true` to `generate` to also get the document `sha256` and the full `validationResult`. Hashing the returned bytes reproduces the hash, so a recipient can check the document independently:

```ts
import { createHash } from 'node:crypto';

const doc = await beliq.generate({ standard: 'xrechnung', invoice, seal: true });
const ok = createHash('sha256').update(doc.bytes).digest('hex') === doc.sha256;
console.log(doc.validationResult?.valid, doc.meta.rulesetSha256, ok);
```

### Choosing the ruleset

`validate` checks a document against the latest rules unless you choose otherwise. `ruleset` chooses: `'previous'` runs the retained rules before the latest, where the format has any, and comma-separated `<artifactKey>:<version>` pins run exact versions, with the keys and versions `GET /v1/rulesets` lists. The SDK sends the value as given, in the `Beliq-Ruleset` header. Left unset, it sends no header, and the API runs your organisation's default channel, which is `latest` unless your organisation chose `previous` in the dashboard.

```ts
const result = await beliq.validate(xml, { ruleset: 'previous' });
console.log(result.rulesetChannel, result.rulesetFellBack, result.rulesetArtifacts);
```

The result says what applied. `rulesetChannel` and `rulesetFellBack` say which channel: `rulesetFellBack: true` means the format had nothing for `previous` to reach, so the latest rules ran. Under exact pins `rulesetChannel` reads `latest`, whatever version a pin ran. `rulesetArtifacts` and the per-format version fields, such as `schematronVersion`, say which rules ran, and `rulesetSunsetsOn` says until when a retained ruleset is served. `GET /v1/rulesets` gives each format's `previousChannel`: what `previous` reaches for it today.

The API answers a malformed value with a 400 `VALIDATION_ERROR` before any quota is used. It answers a pin to a version it no longer serves with a 422 `VALIDATION_ERROR`, and that request uses up a document. The API's `Beliq-Ruleset-Resolved` response header is not returned: it is built from the request, so for pins it repeats the pins sent even when a pinned artifact did not run. `rulesetArtifacts` says what ran.

### Curated option lists

`LIVE_GENERATE_PRESETS` is the set of public generate targets beliq.eu itself offers, each mapping to the API `standard` (plus `profile`/`facturxProfile`) it needs. NLCIUS is a Peppol BIS profile and lives here rather than in `LIVE_GENERATE_STANDARDS`. Connectors build their dropdowns from these lists.

```ts
import { LIVE_GENERATE_PRESETS } from '@beliq/sdk';

const nlcius = LIVE_GENERATE_PRESETS.find((p) => p.id === 'nlcius');
await beliq.generate({ standard: nlcius!.standard, profile: nlcius!.profile, invoice });
```

### Verdict and convert wording

`@beliq/sdk/helpers` holds the words the beliq tools print for a verdict, so each tool says the same thing. `verdictWord` gives `VALID`, `INVALID`, or `NOT VALIDATED` when no ruleset ran. `checkDepth` gives `verificationBadgeLabel` as the API sent it, or `check depth not stated` when it sent none. `franceBlockLines` gives the API's explanation when `franceCtcBlockingRuleIds` is present. `pdfInputLine` and `rulesetChannelLine` restate `pdfInput` and the ruleset channel. `CONVERT_PDF_LINE` says what a PDF that `convert` returns is.

```ts
import { checkDepth, franceBlockLines, verdictWord } from '@beliq/sdk/helpers';

const result = await beliq.validate(xml);
console.log(...franceBlockLines(result), `${verdictWord(result)} (${checkDepth(result)})`);
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
npm run sync:spec      # refresh openapi.json from the live spec (or BELIQ_OPENAPI_PATH)
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
npm run scrub:check   # no em-dash in any tracked file
npm test            # unit tests (no network)
BELIQ_API_KEY=blq_xxx npm run test:integration   # hits the live API; draws quota
```

## Publishing

Released to npm as [`@beliq/sdk`](https://www.npmjs.com/package/@beliq/sdk). Releases run from `.github/workflows/release.yml` via npm Trusted Publishing (OIDC, with provenance): bump `version` in `package.json`, run `npm install --package-lock-only`, add the release's entry to [`CHANGELOG.md`](CHANGELOG.md), merge, then push a `v*.*.*` tag on the merge commit to publish. No npm token is stored in the repo.

## License

MIT
