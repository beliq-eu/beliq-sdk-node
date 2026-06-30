import { buildRequest, type BuildParams } from './buildRequest';
import { BeliqApiError, errorFromResponse, parseEnvelope } from './errors';
import { DEFAULT_BASE_URL } from './constants';
import { sniffContentType, toBytes, decodeUtf8, type DocumentInput, type PlainObject } from './internal';
import { send, type ResolvedConfig, type RawResponse } from './transport';
import type {
  AccountInfo,
  ConvertSourceFormat,
  ConvertTargetFormat,
  FacturxProfile,
  GenerateProfile,
  Invoice,
  ParseFormat,
  ParseResult,
  Standard,
  ValidateFormat,
  ValidationResult,
} from './types';

export interface BeliqOptions {
  /** API key from the beliq dashboard (API Keys). */
  apiKey: string;
  /** Override only for a self-hosted or staging deployment. */
  baseUrl?: string;
  /** How to send the key: 'header' => X-API-Key (default), 'bearer' => Authorization. */
  auth?: 'header' | 'bearer';
  /** Inject a fetch implementation (tests, custom agents). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface GenerateInput {
  standard: Standard;
  invoice: Invoice;
  /** 'xml' (default) or 'pdf' (Factur-X / ZUGFeRD hybrid). */
  output?: 'xml' | 'pdf';
  profile?: GenerateProfile;
  /** Applies only when standard is facturx or zugferd. */
  facturxProfile?: FacturxProfile;
  /** Validate the generated document before returning (fail-closed). */
  verify?: boolean;
  template?: 'standard';
  /** Render the PDF from a saved dashboard template. */
  pdfTemplateId?: string;
  /** Raw JSON deep-merged into the request body. */
  advanced?: PlainObject;
}

export interface DocumentOptions {
  /** Override the sniffed request content type (application/xml | application/pdf). */
  contentType?: string;
  /** Raw JSON deep-merged into the query. */
  advanced?: PlainObject;
}

export interface ValidateOptions extends DocumentOptions {
  format?: ValidateFormat;
  franceCtc?: boolean;
}

export interface ParseOptions extends DocumentOptions {
  format?: ParseFormat;
}

export interface ConvertOptions extends DocumentOptions {
  targetFormat: ConvertTargetFormat;
  sourceFormat?: ConvertSourceFormat;
  /** Applies only when targetFormat is facturx or zugferd. */
  targetProfile?: FacturxProfile;
  dropFranceCtcOverlay?: boolean;
}

/** Header metadata returned alongside a generated document. */
export interface GenerateMeta {
  schematronVersion?: string;
  pdfKind?: string;
  outputEnvelope?: string;
}

export interface GenerateResult {
  contentType: string;
  bytes: Uint8Array;
  /** UTF-8 decoded body, present only for an XML output. */
  xml?: string;
  meta: GenerateMeta;
}

/** Header metadata returned alongside a converted document. */
export interface ConvertMeta {
  sourceFormat?: string;
  targetFormat?: string;
  profileDetected?: string;
  lostElementsCount?: number;
  lostElements?: string[];
  conversionTools?: string;
}

export interface ConvertResult {
  contentType: string;
  bytes: Uint8Array;
  meta: ConvertMeta;
}

function generateMeta(headers: Headers): GenerateMeta {
  return {
    schematronVersion: headers.get('x-schematron-version') ?? undefined,
    pdfKind: headers.get('x-pdf-kind') ?? undefined,
    outputEnvelope: headers.get('x-output-envelope') ?? undefined,
  };
}

function convertMeta(headers: Headers): ConvertMeta {
  let lostElements: string[] | undefined;
  const lostRaw = headers.get('x-lost-elements');
  if (lostRaw) {
    try {
      const parsed: unknown = JSON.parse(lostRaw);
      if (Array.isArray(parsed)) lostElements = parsed.map(String);
    } catch {
      // A non-JSON header is treated as absent rather than fatal.
    }
  }
  const countRaw = headers.get('x-lost-elements-count');
  return {
    sourceFormat: headers.get('x-source-format') ?? undefined,
    targetFormat: headers.get('x-target-format') ?? undefined,
    profileDetected: headers.get('x-profile-detected') ?? undefined,
    lostElementsCount: countRaw != null ? Number(countRaw) : undefined,
    lostElements,
    conversionTools: headers.get('x-conversion-tools') ?? undefined,
  };
}

/** Typed client for the beliq e-invoicing compliance API. */
export class Beliq {
  readonly #config: ResolvedConfig;

  constructor(options: BeliqOptions) {
    if (!options?.apiKey) throw new Error('beliq: apiKey is required');
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('beliq: no global fetch available; pass options.fetch');
    }
    this.#config = {
      apiKey: options.apiKey,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      auth: options.auth ?? 'header',
      fetchImpl,
    };
  }

  /** Account, plan, and quota context for the key. Does not consume quota. */
  async me(): Promise<AccountInfo> {
    return this.#json<AccountInfo>({ operation: 'me' });
  }

  /** Generate a compliant e-invoice from an EN 16931 object. */
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await send(this.#config, buildRequest({ operation: 'generate', ...input }));
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const isXml = contentType.includes('xml');
    return {
      contentType,
      bytes: res.bytes,
      xml: isXml ? decodeUtf8(res.bytes) : undefined,
      meta: generateMeta(res.headers),
    };
  }

  /** Validate a document against authority-pinned rules. */
  async validate(document: DocumentInput, options: ValidateOptions = {}): Promise<ValidationResult> {
    return this.#json<ValidationResult>({
      operation: 'validate',
      ...this.#rawParams(document, options),
      validateFormat: options.format,
      franceCtc: options.franceCtc,
    });
  }

  /** Parse a document into a structured EN 16931 invoice. */
  async parse(document: DocumentInput, options: ParseOptions = {}): Promise<ParseResult> {
    return this.#json<ParseResult>({
      operation: 'parse',
      ...this.#rawParams(document, options),
      parseFormat: options.format,
    });
  }

  /** Convert a document between EN 16931 formats. */
  async convert(document: DocumentInput, options: ConvertOptions): Promise<ConvertResult> {
    const res = await send(
      this.#config,
      buildRequest({
        operation: 'convert',
        ...this.#rawParams(document, options),
        sourceFormat: options.sourceFormat,
        targetFormat: options.targetFormat,
        targetProfile: options.targetProfile,
        dropFranceCtcOverlay: options.dropFranceCtcOverlay,
      }),
    );
    return {
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      bytes: res.bytes,
      meta: convertMeta(res.headers),
    };
  }

  #rawParams(
    document: DocumentInput,
    options: DocumentOptions,
  ): Pick<BuildParams, 'rawBody' | 'rawContentType' | 'advanced'> {
    const rawBody = toBytes(document);
    return {
      rawBody,
      rawContentType: options.contentType ?? sniffContentType(rawBody),
      advanced: options.advanced,
    };
  }

  async #json<T>(params: BuildParams): Promise<T> {
    const res: RawResponse = await send(this.#config, buildRequest(params));
    const envelope = parseEnvelope(res.bytes);
    if (envelope?.success === false) throw errorFromResponse(res.status, res.bytes);
    if (!envelope || envelope.data === undefined) {
      throw new BeliqApiError('beliq: response was not a JSON envelope', { status: res.status });
    }
    return envelope.data as T;
  }
}
