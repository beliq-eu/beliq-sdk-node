import { buildRequest, type BuildParams } from './buildRequest';
import { BeliqApiError, errorFromResponse, parseEnvelope } from './errors';
import { DEFAULT_BASE_URL, DEFAULT_RETRY_BUDGET_MS, DEFAULT_TIMEOUT_MS } from './constants';
import {
  sniffContentType,
  toBytes,
  decodeUtf8,
  decodeBase64,
  type DocumentInput,
  type PlainObject,
} from './internal';
import { send, type ResolvedConfig, type RawResponse } from './transport';
import type {
  AccountInfo,
  ConvertSourceFormat,
  ConvertTargetFormat,
  FacturxProfile,
  GenerateProfile,
  GenerateResponse,
  Invoice,
  ParseFormat,
  ParseResult,
  RulesetArtifact,
  RulesetChannel,
  Standard,
  ValidateFormat,
  ValidationResult,
} from './types';

/** blq_test_ marks a sandbox key; the server derives livemode from this exact prefix. */
const TEST_KEY_PREFIX = 'blq_test_';

export interface BeliqOptions {
  /** API key from the beliq dashboard (API Keys). */
  apiKey: string;
  /** Override only for a self-hosted or staging deployment. */
  baseUrl?: string;
  /** How to send the key: 'header' => X-API-Key (default), 'bearer' => Authorization. */
  auth?: 'header' | 'bearer';
  /** Inject a fetch implementation (tests, custom agents). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Per-attempt deadline in ms (default 90000). Generous on purpose: beliq runs
   * the full Schematron rule set over a document, so a generate or validate can
   * take tens of seconds legitimately. Set well above the latency you expect:
   * a deadline shorter than the server's own means giving up on work that is
   * still running, and this client does not retry its own timeout, since the
   * work may have finished. 0 disables the deadline.
   */
  timeoutMs?: number;
  /**
   * Extra attempts after the first for the failures retried by count (default
   * 3): a 429 other than `QUOTA_EXCEEDED`, a 502 or 503 carrying any beliq error
   * code but a 503 `DATABASE_UNAVAILABLE`, and any thrown error but a connection
   * that could not be opened, such as a connection lost after the request was
   * sent. When you set it, it bounds every retry, so 0 disables retrying.
   */
  maxRetries?: number;
  /**
   * How long to keep retrying, in ms from the start of the first attempt
   * (default 900000, 15 minutes). A 503 `DATABASE_UNAVAILABLE`, a 502 or 503 with
   * no beliq error code, and a connection that could not be opened are retried
   * until it is spent. Every wait follows the server's `Retry-After` in full; no
   * attempt starts after the budget, so a `Retry-After` longer than what is left
   * ends the call at once. 0 disables retrying.
   */
  retryBudgetMs?: number;
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
  /**
   * Return the verify-it-yourself seal: the response carries the document
   * `sha256` and the full `validationResult` alongside the decoded bytes.
   * `sha256(bytes)` reproduces the returned hash.
   */
  seal?: boolean;
  /** Raw JSON deep-merged into the request body. */
  advanced?: PlainObject;
}

export interface DocumentOptions {
  /** Override the sniffed request content type (application/xml | application/pdf). */
  contentType?: string;
  /**
   * Raw JSON deep-merged into the query; its values win over the named options.
   * The API answers 400 `VALIDATION_ERROR` to a query key the operation does not
   * declare, and `details.fields` names it.
   */
  advanced?: PlainObject;
}

export interface ValidateOptions extends DocumentOptions {
  format?: ValidateFormat;
  franceCtc?: boolean;
  /**
   * The rules to validate against, sent as the `Beliq-Ruleset` header: a channel
   * (`latest` or `previous`), or comma-separated exact pins as
   * `<artifactKey>:<version>`, the keys and versions `GET /v1/rulesets` lists.
   * Left unset, no header is sent, and the API runs the key's organisation
   * default, which is `latest` unless the organisation chose `previous`.
   *
   * The result says what applied: `rulesetChannel` and `rulesetFellBack` which
   * channel, `rulesetArtifacts` and the per-format version fields which rules
   * ran, and `rulesetSunsetsOn` until when a retained ruleset is served. A
   * malformed value is a 400 `VALIDATION_ERROR` before any quota is used; a pin
   * to a version the API no longer serves is a 422 `VALIDATION_ERROR`, and that
   * request uses up a document.
   */
  ruleset?: RulesetChannel | (string & {});
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
  /** Combined ruleset fingerprint the document was checked against. */
  rulesetSha256?: string;
  /** Per-artifact rows behind {@link rulesetSha256}. */
  rulesetArtifacts?: RulesetArtifact[];
  /** True for a live key, false for a blq_test_ sandbox key. */
  livemode?: boolean;
}

export interface GenerateResult {
  contentType: string;
  bytes: Uint8Array;
  /** UTF-8 decoded body, present only for an XML output. */
  xml?: string;
  /** SHA-256 of the returned bytes. Present only when `seal` was requested. */
  sha256?: string;
  /** Validation verdict for the generated document. Present only when `seal` was requested. */
  validationResult?: ValidationResult;
  meta: GenerateMeta;
}

/** One loss a conversion recorded: https://docs.beliq.eu/api-reference/convert/#lostelement-schema */
export interface LostElement {
  path: string;
  value: string | null;
  reason: string;
  severity: 'info' | 'warning';
  acceptableLoss: boolean;
}

/**
 * The one entry `lostElements` holds in place of the list when the list would pass
 * the API's 6 KB header cap. `lostElementsCount` stays the exact count.
 */
export interface LostElementsTruncated {
  truncated: true;
  reason?: string;
}

/** Header metadata returned alongside a converted document. */
export interface ConvertMeta {
  sourceFormat?: string;
  targetFormat?: string;
  profileDetected?: string;
  lostElementsCount?: number;
  lostElements?: Array<LostElement | LostElementsTruncated>;
  conversionTools?: string;
  /** True for a live key, false for a blq_test_ sandbox key. */
  livemode?: boolean;
}

export interface ConvertResult {
  contentType: string;
  bytes: Uint8Array;
  meta: ConvertMeta;
}

// A loop, not /\/+$/: that regex is quadratic on a long run of slashes followed by
// another character (https://github.com/beliq-eu/beliq-sdk-node/security/code-scanning/1).
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/** Read the authoritative per-response mode from the x-beliq-livemode header. */
function livemodeHeader(headers: Headers): boolean | undefined {
  const raw = headers.get('x-beliq-livemode');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** The x-ruleset-artifacts header is a JSON array of {key, version, fileSha256}. */
function parseRulesetArtifacts(headers: Headers): RulesetArtifact[] | undefined {
  const raw = headers.get('x-ruleset-artifacts');
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RulesetArtifact[]) : undefined;
  } catch {
    // A non-JSON header is treated as absent rather than fatal.
    return undefined;
  }
}

function parseLostElements(headers: Headers): ConvertMeta['lostElements'] {
  const raw = headers.get('x-lost-elements');
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NonNullable<ConvertMeta['lostElements']>) : undefined;
  } catch {
    // A non-JSON header is treated as absent rather than fatal.
    return undefined;
  }
}

function generateMeta(headers: Headers): GenerateMeta {
  return {
    schematronVersion: headers.get('x-schematron-version') ?? undefined,
    pdfKind: headers.get('x-pdf-kind') ?? undefined,
    outputEnvelope: headers.get('x-output-envelope') ?? undefined,
    rulesetSha256: headers.get('x-ruleset-sha256') ?? undefined,
    rulesetArtifacts: parseRulesetArtifacts(headers),
    livemode: livemodeHeader(headers),
  };
}

function convertMeta(headers: Headers): ConvertMeta {
  const countRaw = headers.get('x-lost-elements-count');
  return {
    sourceFormat: headers.get('x-source-format') ?? undefined,
    targetFormat: headers.get('x-target-format') ?? undefined,
    profileDetected: headers.get('x-profile-detected') ?? undefined,
    lostElementsCount: countRaw != null ? Number(countRaw) : undefined,
    lostElements: parseLostElements(headers),
    conversionTools: headers.get('x-conversion-tools') ?? undefined,
    livemode: livemodeHeader(headers),
  };
}

/** Typed client for the beliq e-invoice API. */
export class Beliq {
  readonly #config: ResolvedConfig;

  /**
   * True for a live key, false for a blq_test_ sandbox key, derived from the key
   * prefix (the same rule the server applies). Available before any request; the
   * per-response x-beliq-livemode header is surfaced on generate/convert meta.
   */
  readonly livemode: boolean;

  constructor(options: BeliqOptions) {
    if (!options?.apiKey) throw new Error('beliq: apiKey is required');
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('beliq: no global fetch available; pass options.fetch');
    }
    this.livemode = !options.apiKey.startsWith(TEST_KEY_PREFIX);
    this.#config = {
      apiKey: options.apiKey,
      baseUrl: trimTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL),
      auth: options.auth ?? 'header',
      fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries,
      retryBudgetMs: options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS,
    };
  }

  /** Account, plan, and quota context for the key. Does not consume quota. */
  async me(): Promise<AccountInfo> {
    return this.#json<AccountInfo>({ operation: 'me' });
  }

  /** Generate an e-invoice from an EN 16931 object. */
  async generate(input: GenerateInput): Promise<GenerateResult> {
    const res = await send(
      this.#config,
      buildRequest({ operation: 'generate', ...input, sealed: input.seal }),
    );
    const meta = generateMeta(res.headers);

    if (input.seal) {
      const envelope = parseEnvelope(res.bytes);
      if (envelope?.success === false) throw errorFromResponse(res.status, res.bytes);
      const data = envelope?.data as GenerateResponse | undefined;
      if (!data || data.output === undefined) {
        throw new BeliqApiError('beliq: seal response was not a JSON envelope', {
          status: res.status,
        });
      }
      const bytes = decodeBase64(data.output);
      const contentType = data.contentType ?? 'application/octet-stream';
      return {
        contentType,
        bytes,
        xml: contentType.includes('xml') ? decodeUtf8(bytes) : undefined,
        sha256: data.sha256,
        validationResult: data.validationResult,
        meta,
      };
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return {
      contentType,
      bytes: res.bytes,
      xml: contentType.includes('xml') ? decodeUtf8(res.bytes) : undefined,
      meta,
    };
  }

  /** Validate a document. The result names the rules that ran and, in `verificationBadgeLabel` when the API states one, the check depth. */
  async validate(document: DocumentInput, options: ValidateOptions = {}): Promise<ValidationResult> {
    return this.#json<ValidationResult>({
      operation: 'validate',
      ...this.#rawParams(document, options),
      validateFormat: options.format,
      franceCtc: options.franceCtc,
      ruleset: options.ruleset,
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
