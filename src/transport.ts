import type { BuiltRequest } from './buildRequest';
import { errorFromResponse } from './errors';

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  auth: 'header' | 'bearer';
  fetchImpl: typeof fetch;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

function authHeaders(config: ResolvedConfig): Record<string, string> {
  return config.auth === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'X-API-Key': config.apiKey };
}

function buildUrl(baseUrl: string, path: string, query?: BuiltRequest['query']): string {
  if (!query) return `${baseUrl}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
}

/**
 * Perform the request and return the raw response. Throws BeliqApiError on any
 * non-2xx status (the body is parsed for the `{ success:false, error }`
 * envelope). The caller interprets a 2xx body per the request's outputKind.
 */
export async function send(config: ResolvedConfig, req: BuiltRequest): Promise<RawResponse> {
  const headers: Record<string, string> = { ...authHeaders(config) };
  if (req.contentType) headers['Content-Type'] = req.contentType;

  const body =
    req.jsonBody !== undefined ? JSON.stringify(req.jsonBody) : req.rawBody;

  const res = await config.fetchImpl(buildUrl(config.baseUrl, req.path, req.query), {
    method: req.method,
    headers,
    body,
  });

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw errorFromResponse(res.status, bytes);
  return { status: res.status, headers: res.headers, bytes };
}
