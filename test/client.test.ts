import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Beliq, BeliqApiError } from '../src/index';
import type { Invoice } from '../src/index';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const decode = (b: unknown): string => new TextDecoder().decode(b as Uint8Array);
const apiKey = 'blq_test_key';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string | Uint8Array;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A fake fetch that records every request and replies from the responder. */
function mock(responder: (call: Captured) => MockResponse) {
  const calls: Captured[] = [];
  const impl = async (input: string | URL, init?: FetchInit): Promise<Response> => {
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);
    const r = responder(call);
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers });
  };
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

function minimalInvoice(): Invoice {
  return {
    number: 'IT-2026-001',
    issueDate: '2026-01-15',
    currencyCode: 'EUR',
    seller: { name: 'Seller GmbH', address: { city: 'Berlin', postalCode: '10115', countryCode: 'DE' } },
    buyer: { name: 'Buyer GmbH', address: { city: 'Munich', postalCode: '80331', countryCode: 'DE' } },
    lines: [
      { description: 'Consulting', quantity: 10, unitCode: 'HUR', unitPrice: 100, lineTotal: 1000, vatRate: 19, vatCategoryCode: 'S' },
    ],
    totalNetAmount: 1000,
    totalTaxAmount: 190,
    totalGrossAmount: 1190,
  };
}

describe('Beliq client', () => {
  it('requires an apiKey', () => {
    expect(() => new Beliq({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('me() GETs /v1/me with the X-API-Key header and parses the envelope', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('me.json') }));
    const acct = await new Beliq({ apiKey, fetch: fetchImpl }).me();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.beliq.eu/v1/me');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers['X-API-Key']).toBe(apiKey);
    expect(calls[0].headers['Authorization']).toBeUndefined();
    expect(acct.org.name).toBe('Acme GmbH');
    expect(acct.quota.remaining).toBe(9863);
  });

  it('strips a trailing slash from a custom baseUrl', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('me.json') }));
    await new Beliq({ apiKey, baseUrl: 'https://staging.beliq.eu/', fetch: fetchImpl }).me();
    expect(calls[0].url).toBe('https://staging.beliq.eu/v1/me');
  });

  it('validate() posts raw XML with the right query and parses the result', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('validate-invalid.json') }));
    const xml = '<rsm:CrossIndustryInvoice/>';
    const result = await new Beliq({ apiKey, fetch: fetchImpl }).validate(xml, { format: 'cii' });
    const call = calls[0];
    expect(call.url).toBe('https://api.beliq.eu/v1/validate?format=cii');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/xml');
    expect(decode(call.body)).toBe(xml);
    expect(result.valid).toBe(false);
    expect(result.errors[0].ruleId).toBe('BR-DE-15');
    expect(result.errors[0].severity).toBe('error');
    expect(result.schematronVersion).toBe('1.3.16');
  });

  it('honors auth:bearer and serializes boolean query params', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('validate-invalid.json') }));
    await new Beliq({ apiKey, auth: 'bearer', fetch: fetchImpl }).validate('<x/>', {
      format: 'auto',
      franceCtc: true,
    });
    const call = calls[0];
    expect(call.headers['Authorization']).toBe(`Bearer ${apiKey}`);
    expect(call.headers['X-API-Key']).toBeUndefined();
    expect(call.url).toBe('https://api.beliq.eu/v1/validate?format=auto&franceCtc=true');
  });

  it('sniffs application/pdf from the document bytes', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('validate-invalid.json') }));
    await new Beliq({ apiKey, fetch: fetchImpl }).validate(new TextEncoder().encode('%PDF-1.7'));
    expect(calls[0].headers['Content-Type']).toBe('application/pdf');
    expect(calls[0].url).toBe('https://api.beliq.eu/v1/validate');
  });

  it('parse() posts to /v1/parse and returns the structured invoice', async () => {
    const { fetchImpl, calls } = mock(() => ({ body: fixture('parse.json') }));
    const result = await new Beliq({ apiKey, fetch: fetchImpl }).parse('<x/>', { format: 'auto' });
    expect(calls[0].url).toBe('https://api.beliq.eu/v1/parse?format=auto');
    expect(result.format).toBe('cii');
    expect(result.invoice.number).toBe('IT-2026-001');
  });

  it('generate() posts JSON and returns decoded XML plus header metadata', async () => {
    const xmlDoc = '<?xml version="1.0"?><rsm:CrossIndustryInvoice/>';
    const { fetchImpl, calls } = mock(() => ({
      body: xmlDoc,
      headers: { 'content-type': 'application/xml', 'x-schematron-version': '1.3.16', 'x-output-envelope': 'cii' },
    }));
    const result = await new Beliq({ apiKey, fetch: fetchImpl }).generate({
      standard: 'xrechnung',
      verify: true,
      invoice: minimalInvoice(),
    });
    const call = calls[0];
    expect(call.url).toBe('https://api.beliq.eu/v1/generate');
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    const sent = JSON.parse(call.body as string);
    expect(sent).toMatchObject({ standard: 'xrechnung', output: 'xml', verify: true });
    expect(sent.invoice.number).toBe('IT-2026-001');
    expect(result.contentType).toContain('application/xml');
    expect(result.xml).toBe(xmlDoc);
    expect(result.meta.schematronVersion).toBe('1.3.16');
    expect(result.meta.outputEnvelope).toBe('cii');
  });

  it('generate() returns raw bytes (no xml) for a PDF output', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7\nbinary');
    const { fetchImpl } = mock(() => ({
      body: pdfBytes,
      headers: { 'content-type': 'application/pdf', 'x-pdf-kind': 'PDF/A-3B' },
    }));
    const result = await new Beliq({ apiKey, fetch: fetchImpl }).generate({
      standard: 'zugferd',
      output: 'pdf',
      facturxProfile: 'en16931',
      invoice: minimalInvoice(),
    });
    expect(result.xml).toBeUndefined();
    expect(decode(result.bytes).startsWith('%PDF-')).toBe(true);
    expect(result.meta.pdfKind).toBe('PDF/A-3B');
  });

  it('convert() posts raw bytes and maps conversion metadata headers', async () => {
    const ublDoc = '<Invoice xmlns="urn:oasis:names:specification:ubl"/>';
    const { fetchImpl, calls } = mock(() => ({
      body: ublDoc,
      headers: {
        'content-type': 'application/xml',
        'x-source-format': 'cii',
        'x-target-format': 'ubl',
        'x-profile-detected': 'en16931',
        'x-lost-elements-count': '2',
        'x-lost-elements': '["BT-22","BT-23"]',
        'x-conversion-tools': 'beliq-engine@1.0',
      },
    }));
    const result = await new Beliq({ apiKey, fetch: fetchImpl }).convert('<rsm:CrossIndustryInvoice/>', {
      targetFormat: 'ubl',
      sourceFormat: 'auto',
    });
    expect(calls[0].url).toBe('https://api.beliq.eu/v1/convert?sourceFormat=auto&targetFormat=ubl');
    expect(calls[0].headers['Content-Type']).toBe('application/xml');
    expect(result.meta.targetFormat).toBe('ubl');
    expect(result.meta.lostElementsCount).toBe(2);
    expect(result.meta.lostElements).toEqual(['BT-22', 'BT-23']);
    expect(result.meta.conversionTools).toBe('beliq-engine@1.0');
    expect(decode(result.bytes)).toBe(ublDoc);
  });

  it('throws BeliqApiError with the typed code on a 4xx (JSON endpoint)', async () => {
    const { fetchImpl } = mock(() => ({ status: 400, body: fixture('error-invalid-xml.json') }));
    const err = await new Beliq({ apiKey, fetch: fetchImpl })
      .validate('not xml')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BeliqApiError);
    const apiErr = err as BeliqApiError;
    expect(apiErr.code).toBe('INVALID_XML');
    expect(apiErr.status).toBe(400);
    expect(apiErr.message).toContain('not well-formed');
    expect(apiErr.details).toEqual({ line: 1 });
  });

  it('parses the error envelope even when a binary endpoint fails', async () => {
    const { fetchImpl } = mock(() => ({ status: 422, body: fixture('error-invalid-xml.json') }));
    const err = await new Beliq({ apiKey, fetch: fetchImpl })
      .convert('<x/>', { targetFormat: 'ubl' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BeliqApiError);
    expect((err as BeliqApiError).code).toBe('INVALID_XML');
    expect((err as BeliqApiError).status).toBe(422);
  });
});
