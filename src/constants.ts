// Curated option lists for end-user UX surfaces (connector dropdowns, docs).
// These are the LIVE, authority-pinned public subset, intentionally narrower
// than the generated type unions: provisional formats the API can technically
// accept (fatturapa, sdi_messaggio, facturae, eslog) are withheld from public
// option lists per LPD-1. The generated types in ./generated stay faithful to
// the full API surface; these constants are what we surface to users.

export const DEFAULT_BASE_URL = 'https://api.beliq.eu';

export const LIVE_GENERATE_STANDARDS = ['xrechnung', 'zugferd', 'facturx', 'peppol-bis'] as const;

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
