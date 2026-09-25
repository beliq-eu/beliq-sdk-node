# Changelog

`@beliq/sdk` is on a 0.x line, so a caret range pins the minor: `^0.4.0`
resolves 0.4.x and never reaches 0.5.0. Additive spec syncs ship as patches for
that reason, and a minor is reserved for a change that needs consumers to opt in.

## 0.4.3 - 2026-09-26

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
- The vendored `openapi.json` is asserted byte-identical to what beliq-api
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
