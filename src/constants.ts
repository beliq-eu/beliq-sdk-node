// Curated option lists for end-user UX surfaces (connector dropdowns, docs).
// Each list carries every value the API accepts for its operation, which is
// also every format GET /v1/rulesets publishes, each wearing the badge that
// says how deep its check goes. A list narrower than the API's own enum states
// its reason beside it. The generated types in ./generated stay faithful to
// the full API surface; these constants are what we surface to users.

export const DEFAULT_BASE_URL = 'https://api.beliq.eu';

/**
 * Per-attempt deadline. Sits above the API's own worst case so the server is
 * always the one to answer: a client that gives up first abandons work that is
 * still running, and cannot tell whether the document was produced.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

/** Extra attempts after the first, for 429 / 502 / 503 only. */
export const DEFAULT_MAX_RETRIES = 3;

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

export const LIVE_VALIDATE_FORMATS = ['auto', 'cii', 'ubl'] as const;

export const LIVE_PARSE_FORMATS = ['auto', 'cii', 'ubl'] as const;

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
