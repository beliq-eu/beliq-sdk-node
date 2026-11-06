// Curated option lists for end-user UX surfaces (connector dropdowns, docs).
// Each list carries every value the API accepts for its operation. A list
// narrower than the API's own enum states its reason beside it.
// GET /v1/rulesets carries each format's badge, which says how deep its check
// goes. The generated types in ./generated stay faithful to the full API
// surface; these constants are what we surface to users.

export const DEFAULT_BASE_URL = 'https://api.beliq.eu';

/**
 * Per-attempt deadline. Sits above the API's own worst case so the server is
 * always the one to answer: a client that gives up first abandons work that is
 * still running, and cannot tell whether the document was produced.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Extra attempts after the first for the failures retried by count: a 429 other
 * than `QUOTA_EXCEEDED`, a 502 or 503 carrying any beliq error code but a 503
 * `DATABASE_UNAVAILABLE`, and any thrown error but a connection that could not
 * be opened, such as a connection lost after the request was sent.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * How long the client keeps retrying, from the start of the first attempt: 15
 * minutes. A 503 `DATABASE_UNAVAILABLE`, a 502 or 503 with no beliq error code,
 * and a connection that could not be opened are retried until it is spent. No
 * standard sets the value: it is beliq's own, sized to outlast two of the three
 * database outages beliq has measured, of about 9 and 12 minutes. The third
 * lasted 33 minutes.
 */
export const DEFAULT_RETRY_BUDGET_MS = 900_000;

/**
 * Every `standard` POST /v1/generate accepts, in the order its enum lists them.
 * The four national formats are Schema-checked: their authority publishes a
 * schema and no machine-readable business rules, so beliq checks structure and
 * says so. GET /v1/rulesets carries each one's badge.
 */
export const LIVE_GENERATE_STANDARDS = [
  'xrechnung',
  'zugferd',
  'facturx',
  'peppol-bis',
  'fatturapa',
  'facturae',
  'eslog',
  'ksef',
] as const;

/** A named generate target: the API `standard` plus the `profile`/`facturxProfile`/`output` it needs. */
export interface GeneratePreset {
  id: string;
  label: string;
  standard: (typeof LIVE_GENERATE_STANDARDS)[number];
  output: 'xml' | 'pdf';
  /** API `profile`; omitted lets the engine pick the standard's default. */
  profile?: string;
  /** API `facturxProfile`; Factur-X / ZUGFeRD only. */
  facturxProfile?: string;
}

/**
 * Named generate targets surfaced to end users (connector dropdowns), mirroring
 * the public set on beliq.eu's own generator. NLCIUS is a Peppol BIS profile,
 * not a standalone standard, so it is reachable here rather than through
 * LIVE_GENERATE_STANDARDS or the Factur-X-only LIVE_PROFILES.
 */
export const LIVE_GENERATE_PRESETS: readonly GeneratePreset[] = [
  { id: 'xrechnung', label: 'XRechnung', standard: 'xrechnung', output: 'xml' },
  { id: 'factur-x', label: 'Factur-X', standard: 'facturx', output: 'pdf', facturxProfile: 'en16931' },
  { id: 'zugferd', label: 'ZUGFeRD', standard: 'zugferd', output: 'pdf' },
  { id: 'peppol-bis', label: 'Peppol BIS 3.0', standard: 'peppol-bis', output: 'xml' },
  { id: 'nlcius', label: 'NLCIUS', standard: 'peppol-bis', output: 'xml', profile: 'netherlands-nlcius' },
];

/**
 * The Factur-X granularity values offered publicly. Kept as the flat list the
 * hybrid-PDF family shares; anything choosing a profile for a specific standard
 * wants LIVE_PROFILES_BY_STANDARD instead, which is what the API enforces.
 */
export const LIVE_PROFILES = ['basicwl', 'en16931', 'extended', 'extended-ctc-fr'] as const;

/**
 * Which profiles each standard accepts, publicly-offered values only.
 *
 * `profile` is not a free enum: the engine pins it per standard and answers a
 * pair outside the table with `422 PROFILE_STANDARD_MISMATCH`
 * (the engine's ALLOWED_PROFILES_FOR_STANDARD table). A
 * surface that offers one flat profile list therefore offers values that cannot
 * succeed: none of the Factur-X granularity values is legal for `xrechnung` or
 * `peppol-bis`, and `extended-ctc-fr` is the AFNOR XP Z12-012 France CTC overlay
 * with no ZUGFeRD-branded counterpart.
 *
 * It carries every standard the API accepts. It stays narrower than the
 * engine's table in one place: the `minimum` and `basic` Factur-X profiles are
 * engine-supported but not offered here (FNFE-MPE source gating).
 *
 * `scripts/check-profile-drift.mjs` compares this against the engine's table.
 */
export const LIVE_PROFILES_BY_STANDARD = {
  xrechnung: ['xrechnung'],
  'peppol-bis': ['peppol', 'romania-ro-cius', 'netherlands-nlcius'],
  zugferd: ['basicwl', 'en16931', 'extended'],
  facturx: ['basicwl', 'en16931', 'extended', 'extended-ctc-fr'],
  fatturapa: ['ordinaria'],
  facturae: ['ordinaria'],
  eslog: ['eracun'],
  ksef: ['fa3'],
} as const satisfies Record<(typeof LIVE_GENERATE_STANDARDS)[number], readonly string[]>;

/** The profiles a caller may choose for `standard`; empty for an unknown standard. */
export function profilesForStandard(standard: string): readonly string[] {
  return (LIVE_PROFILES_BY_STANDARD as Record<string, readonly string[]>)[standard] ?? [];
}

/**
 * Whether `profile` is legal for `standard`. An unknown standard passes: the API
 * is the authority on values this list does not carry, and a client-side guess
 * would refuse a request the server would have accepted.
 */
export function isProfileAllowedForStandard(standard: string, profile: string): boolean {
  const allowed = profilesForStandard(standard);
  return allowed.length === 0 || allowed.includes(profile);
}

/**
 * The `format` values POST /v1/validate accepts that are offered. A named
 * syntax makes the API validate the document as that syntax; `auto` reads it
 * from the document.
 */
export const LIVE_VALIDATE_FORMATS = [
  'auto',
  'cii',
  'ubl',
  'fatturapa',
  'facturae',
  'eslog',
  'poland_ksef_fa3',
] as const;

/** The validate `format` values left out of LIVE_VALIDATE_FORMATS. `auto` still recognises both. */
export const VALIDATE_FORMATS_LEFT_OUT: Readonly<Record<string, string>> = {
  sdi_messaggio:
    'An SdI file message, not an invoice. GET /v1/rulesets has no entry for it.',
  poland_ksef_fa2:
    'The API answers every FA(2) document `valid: false`, led by a `POLAND_KSEF_FA2_SUPERSEDED` error. '
    + 'GET /v1/rulesets has no entry for it.',
};

export const LIVE_PARSE_FORMATS = ['auto', 'cii', 'ubl'] as const;

const PARSE_READS_CII_AND_UBL =
  'POST /v1/parse ignores `format` and reads CII and UBL documents only: the `format` its response states is one of the two.';

/** The parse `format` values left out of LIVE_PARSE_FORMATS. */
export const PARSE_FORMATS_LEFT_OUT: Readonly<Record<string, string>> = {
  fatturapa: PARSE_READS_CII_AND_UBL,
  facturae: PARSE_READS_CII_AND_UBL,
  eslog: PARSE_READS_CII_AND_UBL,
  sdi_messaggio: PARSE_READS_CII_AND_UBL,
  poland_ksef_fa2: PARSE_READS_CII_AND_UBL,
  poland_ksef_fa3: PARSE_READS_CII_AND_UBL,
};

export const LIVE_CONVERT_SOURCE_FORMATS = [
  'auto',
  'cii',
  'ubl',
  'zugferd',
  'facturx',
  'xrechnung',
  'peppol-bis',
] as const;

export const LIVE_CONVERT_TARGET_FORMATS = [
  'cii',
  'ubl',
  'zugferd',
  'facturx',
  'xrechnung',
  'peppol-bis',
] as const;
