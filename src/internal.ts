// Pure, dependency-free helpers shared by the client and the request builder.
// Kept side-effect free so they unit-test without a network or runtime.

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge `source` into `target` (source wins). Arrays and scalars overwrite. */
export function mergeDeep(target: PlainObject, source: PlainObject): PlainObject {
  const out: PlainObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    // The advanced JSON is caller-supplied; skip prototype-pollution keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeDeep(out[key] as PlainObject, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Drop undefined/empty entries so optional query params are omitted, not sent blank. */
export function compactQuery(query: PlainObject): PlainObject {
  const out: PlainObject = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
}

/** Document bytes a caller may pass to validate/parse/convert. */
export type DocumentInput = string | Uint8Array | ArrayBuffer | ArrayBufferView;

export function toBytes(input: DocumentInput): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('beliq: document must be a string, Uint8Array, ArrayBuffer, or typed array');
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Decode base64 (standard or url-safe) to bytes across Node, browser, and worker runtimes. */
export function decodeBase64(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const maybeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (maybeBuffer) return new Uint8Array(maybeBuffer.from(b64, 'base64'));
  throw new Error('beliq: no base64 decoder available in this runtime');
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Sniff `application/pdf` vs `application/xml` from the leading bytes. */
export function sniffContentType(bytes: Uint8Array): string {
  const isPdf =
    bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
  return isPdf ? 'application/pdf' : 'application/xml';
}
