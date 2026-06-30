// Pure request builder: maps resolved operation params to a normalized request
// descriptor. Side-effect free so it unit-tests without a network. The five
// operations are heterogeneous (see the table in the README):
//   me            GET,  no body,        JSON envelope out
//   generate      POST, JSON body,      document bytes out (xml or pdf)
//   validate      POST, raw bytes body, JSON envelope out
//   parse         POST, raw bytes body, JSON envelope out
//   convert       POST, raw bytes body, document bytes out
import { compactQuery, mergeDeep, type PlainObject } from './internal';

export type Operation = 'me' | 'generate' | 'validate' | 'parse' | 'convert';

/** 'json' => parse the `{ success, data }` envelope; 'binary' => return raw bytes. */
export type OutputKind = 'json' | 'binary';

export type QueryValue = string | number | boolean;

export interface BuildParams {
  operation: Operation;

  // generate (JSON body in, document bytes out)
  standard?: string;
  profile?: string;
  output?: 'xml' | 'pdf';
  facturxProfile?: string;
  invoice?: PlainObject;
  verify?: boolean;
  template?: string;
  pdfTemplateId?: string;

  // validate / parse / convert (raw document bytes in)
  rawBody?: Uint8Array;
  rawContentType?: string;

  // validate
  validateFormat?: string;
  franceCtc?: boolean;

  // parse
  parseFormat?: string;

  // convert
  sourceFormat?: string;
  targetFormat?: string;
  targetProfile?: string;
  dropFranceCtcOverlay?: boolean;

  /** Deep-merged into the request body (generate) or query (raw-input ops). */
  advanced?: PlainObject;
}

export interface BuiltRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, QueryValue>;
  /** Set for generate (JSON request body). */
  jsonBody?: PlainObject;
  /** Set for validate/parse/convert (raw document bytes). */
  rawBody?: Uint8Array;
  /** Request content type; absent for GET. */
  contentType?: string;
  outputKind: OutputKind;
}

/** Profiles only apply to the Factur-X / ZUGFeRD hybrid-PDF family. */
function isFacturxFamily(standardOrFormat: string | undefined): boolean {
  return standardOrFormat === 'facturx' || standardOrFormat === 'zugferd';
}

function withAdvancedQuery(query: PlainObject, advanced?: PlainObject): Record<string, QueryValue> {
  const base = compactQuery(query);
  const merged = advanced && Object.keys(advanced).length > 0 ? mergeDeep(base, advanced) : base;
  return merged as Record<string, QueryValue>;
}

export function buildRequest(params: BuildParams): BuiltRequest {
  switch (params.operation) {
    case 'me':
      return { method: 'GET', path: '/v1/me', outputKind: 'json' };

    case 'generate': {
      const body: PlainObject = {
        standard: params.standard,
        output: params.output ?? 'xml',
        invoice: params.invoice ?? {},
      };
      if (params.profile) body.profile = params.profile;
      if (params.facturxProfile && isFacturxFamily(params.standard)) {
        body.facturxProfile = params.facturxProfile;
      }
      if (typeof params.verify === 'boolean') body.verify = params.verify;
      if (params.template) body.template = params.template;
      if (params.pdfTemplateId) body.pdfTemplateId = params.pdfTemplateId;

      const merged =
        params.advanced && Object.keys(params.advanced).length > 0
          ? mergeDeep(body, params.advanced)
          : body;

      return {
        method: 'POST',
        path: '/v1/generate',
        jsonBody: merged,
        contentType: 'application/json',
        outputKind: 'binary',
      };
    }

    case 'validate': {
      const query: PlainObject = { format: params.validateFormat };
      if (typeof params.franceCtc === 'boolean') query.franceCtc = params.franceCtc;
      return {
        method: 'POST',
        path: '/v1/validate',
        query: withAdvancedQuery(query, params.advanced),
        rawBody: params.rawBody,
        contentType: params.rawContentType ?? 'application/xml',
        outputKind: 'json',
      };
    }

    case 'parse':
      return {
        method: 'POST',
        path: '/v1/parse',
        query: withAdvancedQuery({ format: params.parseFormat }, params.advanced),
        rawBody: params.rawBody,
        contentType: params.rawContentType ?? 'application/xml',
        outputKind: 'json',
      };

    case 'convert': {
      const query: PlainObject = {
        sourceFormat: params.sourceFormat,
        targetFormat: params.targetFormat,
      };
      if (params.targetProfile && isFacturxFamily(params.targetFormat)) {
        query.targetProfile = params.targetProfile;
      }
      if (typeof params.dropFranceCtcOverlay === 'boolean') {
        query.dropFranceCtcOverlay = params.dropFranceCtcOverlay;
      }
      return {
        method: 'POST',
        path: '/v1/convert',
        query: withAdvancedQuery(query, params.advanced),
        rawBody: params.rawBody,
        contentType: params.rawContentType ?? 'application/xml',
        outputKind: 'binary',
      };
    }
  }
}
