# Changelog

`@beliq/sdk` is on a 0.x line, so a caret range pins the minor: `^0.4.0`
resolves 0.4.x and never reaches 0.5.0. Additive spec syncs ship as patches for
that reason, and a minor is reserved for a change that needs consumers to opt in.

## 0.5.1 - 2026-10-11

A patch: the types gain two fields and two error codes. No method changes.

- The vendored `openapi.json` is document `0.15.0` of the API, up from
  `0.12.0`.
- `ValidationResult` gains `verificationBadgeLabel`, the English label of the
  badge in `verificationBadge`. It is display text: print it as it is, and
  compare `verificationBadge` in code. The API sets it only beside the badge,
  so a result with no badge has no label. The `validationResult` of a sealed
  `generate()` is the same type and carries it too.
- `ValidationResult` gains `pdfInput`, which the API sets when the document
  sent to `validate()` was a PDF: the name of the embedded file the verdict is
  about, how that file was found, how many candidates the PDF holds, and
  `containerChecked: false`, because nothing checked the PDF around it.
- The error code union gains `CONVERSION_OUTPUT_INVALID` and `PDFA_VIOLATION`.
  `convert()` answers 422 `CONVERSION_OUTPUT_INVALID` when the converted XML
  fails validation: the document is not returned, and the verdict is in
  `err.details.validationResult`. `generate()` answers 422 `PDFA_VIOLATION`
  when veraPDF reports a violation of its PDF/A-3b profile in a ZUGFeRD or
  Factur-X PDF it built: the PDF is not returned, and the failed rules are in
  `err.details.failedRules`. A `switch` over the code that TypeScript checks
  for exhaustiveness needs the two new cases.

## 0.5.0 - 2026-10-08

A minor, because code that reads a `parse()` result can stop compiling, and a
`^0.4.0` range does not reach a minor. Only the types of `parse()` change. No
method does.

- `ParseResult['invoice']` is the invoice `POST /v1/parse` declares for its
  answer, where it was the invoice `generate()` takes. It lists the 13 fields
  the parser returns, and only `lines` is always present:
  `result.invoice.number` was a `string` and is a `string | undefined`. Below
  the invoice nothing is required but the `id` of a `delivery.locationId`,
  which is optional itself. The 35 fields of the generate invoice that parse
  does not return, such as `allowances`, `paymentMeans` and `taxSummary`, are
  gone from the type. A line lists 7 fields where it listed 20, a party 4
  where it listed 9, and a party's address 5 where it listed 9.
- What stops compiling: a read of a field parse does not return, and
  `result.invoice` passed where an `Invoice` is expected, or a party, a line,
  an address or the delivery of it passed where that part of an `Invoice` is.
  With `strictNullChecks` on, which `strict` includes, so does a field used
  as always present, such as `result.invoice.seller.name` or a `string` taken
  from `result.invoice.number`. Check for a field before reading it.
- The types follow the API, which changed first. Since 2026-10-07
  `POST /v1/parse` returns a field only when the parser has a value for it,
  and puts nothing in the place of an absent one. `parse()` hands the answer
  on as it is, so an installed 0.4.6 gets the same answer, and its types still
  say that nine fields of the invoice are always there, and more inside a
  party, an address and a line.
  https://beliq.eu/changelog/ has the API change under that date.
  https://docs.beliq.eu/api-reference/parse/ says what an absent field means,
  and when a `PARSE_VALUE_NOT_FOUND` warning in `result.warnings` names it.
- The vendored `openapi.json` is document `0.12.0` of the API, up from
  `0.9.0`. Besides the parsed invoice one thing differs: the 14 nullable
  fields of `GET /v1/me` and `GET /v1/rulesets` are spelled with
  `nullable: true`, which is what OpenAPI 3.0 has for a nullable field, where
  each had an `anyOf` with a `"type": "null"` arm. The type generated for each
  of the 14 is the same, and two gain an `@enum` doc tag.

## 0.4.6 - 2026-10-06

- The vendored `openapi.json` carries the four fields `POST /v1/parse` answers
  with and the previous copy did not. `warnings` is always present, and empty
  when the parser read every element that holds something: `PARSE_NOT_RETURNED`
  lists what the document carries beyond the parsed `invoice`, by path and
  count, and `PARSE_VALUE_NOT_FOUND` names a field no value could be read for.
  `profileUrn` (BT-24) and `businessProcessId` (BT-23) carry what the document
  states, and the latter is not the `businessProcessId` a `generate()` invoice
  takes, which is an input limited to the three French Flux 2 codes.
  `franceCtcDetected` is true when BT-23 is one of the French cadre de
  facturation codes or BT-24 is the EXTENDED-CTC-FR URN, and absent otherwise.
- `ParseResult` picks all four up from the regenerated schema, and
  `ParseWarning` and `ParseWarningCode` are exported beside it, the way
  `ValidationIssue` is exported beside `ValidationResult`, so a caller can
  annotate a warning without indexing into the result type.

## 0.4.5 - 2026-10-03

- `LIVE_GENERATE_STANDARDS` carries all eight standards `POST /v1/generate`
  accepts, where it had carried four. The four added are the national XSD
  formats: `fatturapa`, `facturae`, `eslog` and `ksef`. Each is Schema-checked,
  meaning structure only and no business rules, because its authority publishes
  no machine-readable rule pack, and `GET /v1/rulesets` carries the badge.
  `LIVE_PROFILES_BY_STANDARD` gains the one profile each allows: `ordinaria`
  for `fatturapa` and `facturae`, `eracun` for `eslog`, `fa3` for `ksef`. The
  map stays narrower than the engine in one place, the Factur-X `minimum` and
  `basic` profiles, for FNFE-MPE source gating. `LIVE_GENERATE_PRESETS` is
  unchanged at five entries: it mirrors what beliq.eu's own generator offers.
- The vendored `openapi.json` carries the corrected `/v1/validate` description.
  It had said that matching a verdict's `rulesetArtifacts` rows against the
  `GET /v1/rulesets` catalog covers publicly-supported formats only, and that a
  national format's components are kept off the catalog. Both were false: the
  catalog publishes every format beliq carries and the component rows each
  ruleset is built from.

## 0.4.4 - 2026-10-02

- Invoices carry additional supporting documents (BG-24) as
  `supportingDocuments`, at most 50 of them: `id` (BT-122), which BR-52
  requires, `description` (BT-123), `externalLocation` (BT-124) and
  `attachment` (BT-125) with the file as base64 `content`, its `mimeCode` and
  its `filename`. An entry can carry a URL, a file, both or neither. Output is
  a CII `ram:AdditionalReferencedDocument` with type code 916, from the
  Factur-X EN16931 profile up, and a UBL `cac:AdditionalDocumentReference`
  with no document type code (UBL-SR-43 admits none here). Factur-X MINIMUM,
  BASIC_WL and BASIC have no slot for it and drop it after the same checks, as
  do the fatturapa, facturae, eslog and ksef targets. Content that is not
  base64, or that decodes to no bytes, is a 400. On XRechnung BR-DE-22 refuses
  two attachments sharing a `filename`, and DE-R-022 does the same on Peppol
  BIS between two German parties; both compare names as written, so names
  differing only in case pass. An attachment counts toward the 1 MiB body
  limit of `POST /v1/generate`, and base64 takes four bytes for every three of
  the file.
- The `format` query parameter of `/v1/parse` now describes itself: it is
  checked against the allowed values and otherwise ignored, because the syntax
  is always read from the document itself. `/v1/parse` shares the invoice
  shape and fills neither `supportingDocuments` nor the fields 0.4.3 added.

## 0.4.3 - 2026-09-26

Never published to npm: the release job refused the tag, because `package.json`
read 0.4.2 at the commit it pointed at. 0.4.4 is the first release that carries
the changes below.

- Invoices can name a payee (BG-10) and a tax representative (BG-11), as
  `payee` and `taxRepresentative`, and state `paidAmount` (BT-113) and
  `roundingAmount` (BT-114), from which the API derives the amount due
  (BT-115). A payee with the seller's name or registration identifier is a
  400. With a payee, UBL output writes `paymentMeans.creditorId` (BT-90) on
  the payee rather than the seller.
- `typeCode` (BT-3) sets the document type code within `documentType`, such as
  `384` for a corrected invoice. A code from the other document type's half of
  BR-CL-01 is a 400, and the fatturapa, facturae and eslog targets answer 422
  `DOCUMENT_TYPE_STANDARD_MISMATCH`.
- `precedingInvoiceReference` (BG-3) is written on invoices as well as credit
  notes. `/v1/parse` shares the invoice shape and fills none of the new fields.

## 0.4.2 - 2026-09-23

- Invoices carry allowances and charges at document level (BG-20, BG-21) and
  line level (BG-27, BG-28), on `/v1/generate` and `/v1/parse`, as
  `allowances` and `charges`. A document-level entry states its own VAT
  category and rate; a line-level entry inherits the line's.
- `GET /v1/rulesets` reports `previousChannel` on every ruleset: what
  `Beliq-Ruleset: previous` reaches for that format today, with
  `servingVersion`, `previousVersion` and a `fallbackReason` of `sunset`,
  `notice-period` or `superseded`.
- The publish job runs in the `release` GitHub environment, whose only
  deployment policy is the `v*.*.*` tag pattern, so an edit to the workflow
  cannot publish from another ref.

## 0.4.1 - 2026-09-21

- Invoice lines carry the item's price detail and identity: `grossPrice`
  (BT-148) with the per-unit `priceDiscount` (BT-147), `priceBaseQuantity`
  (BT-149/150), `standardItemId` (BT-157), `classifications` (BT-158),
  `originCountryCode` (BT-159) and `attributes` (BG-32). A discount needs a
  gross price and `unitPrice` must equal `grossPrice` minus `priceDiscount`, or
  the API answers 400. With a base quantity the line net (BT-131) is quantity x
  (`unitPrice` / `priceBaseQuantity`), which is what lets a caller who prices
  per 100 units pass PEPPOL-EN16931-R120. The fatturapa, facturae and eslog
  targets read none of these fields.
- The release workflow refuses a tag whose version disagrees with
  `package.json`. Tagging v0.4.1 against a manifest reading 0.4.0 used to
  publish 0.4.0 and exit green, leaving a tag naming a version that never
  shipped.

## 0.4.0 - 2026-09-19

- `GET /v1/rulesets` reports retained ruleset versions, so a caller can see
  which older rule sets are still servable rather than only the current one.
- Participant enrollment codes and the invoice delivery fields are typed.
- BT-6 (VAT accounting currency) and BT-111 (VAT amount in the accounting
  currency) are typed on the invoice.
- A scheduled ruleset change reports its capabilities.
- The README's quick-start invoice is one the API accepts as-is.
- An em-dash scrub gate runs over the whole tree before publish, and the
  release workflow carries job timeouts and refuses a tag that is not on `main`.
- The `js-yaml` override floor is raised above GHSA-2883-xcg3-v3hh.

## 0.3.1 - 2026-09-02

- A spent monthly quota is raised, not retried. A 429 carrying
  `QUOTA_EXCEEDED` is terminal, so the SDK makes exactly one attempt; a 429
  carrying `RATE_LIMITED` or `ACCOUNT_THROTTLED` still retries. Retrying an
  exhausted quota only burned the caller's own backoff window.
- The France transmission verdict fields and pre-flight error codes are typed.
- GitHub Actions are pinned to commit SHAs.

## 0.3.0 - 2026-08-30

- A per-standard profile map: which profile each standard accepts, and which
  standards pin their own and reject one sent by the caller.
- A per-attempt deadline, and transient failures are retried.
- The transport defaults are exported from the package entry point, so a caller
  can read the timeout and retry values the SDK ships with.
- The vendored `openapi.json` is asserted byte-identical to what the API
  generates, and the drift check is directional in the code rather than only in
  its comment. Ten Peppol emit error codes, the 413 responses, the verdict
  verification tier and the `/v1/me` response shape are typed; two error codes
  the API no longer declares are dropped.
- eslint 10 and flat config.

## 0.2.0 - 2026-07-24

- Types refreshed to API 0.2.0: the generate seal, `livemode`, and the NLCIUS
  preset.

## 0.1.1 - 2026-06-30

- First published release. TypeScript/JavaScript SDK for the beliq e-invoice
  API: generate, validate, parse and convert, ESM and CommonJS with bundled
  type declarations.
