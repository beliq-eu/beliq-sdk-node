// Curated option lists for end-user UX surfaces (connector dropdowns, docs).
// These are the LIVE, authority-pinned public subset, intentionally narrower
// than the generated type unions: provisional formats the API can technically
// accept (fatturapa, sdi_messaggio, facturae, eslog) are withheld from public
// option lists per LPD-1. The generated types in ./generated stay faithful to
// the full API surface; these constants are what we surface to users.

export const DEFAULT_BASE_URL = 'https://api.beliq.eu';

export const LIVE_GENERATE_STANDARDS = ['xrechnung', 'zugferd', 'facturx', 'peppol-bis'] as const;

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

export const LIVE_PROFILES = ['basicwl', 'en16931', 'extended', 'extended-ctc-fr'] as const;

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
