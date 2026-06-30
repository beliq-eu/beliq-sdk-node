import { describe, expect, it } from 'vitest';
import { buildRequest, type BuildParams } from '../src/buildRequest';
import { mergeDeep, sniffContentType } from '../src/internal';

const bytes = (s: string) => new TextEncoder().encode(s);

function gen(overrides: Partial<BuildParams> = {}): BuildParams {
  return {
    operation: 'generate',
    standard: 'xrechnung',
    output: 'xml',
    invoice: { number: 'INV-1' },
    verify: true,
    ...overrides,
  };
}

function raw(operation: BuildParams['operation'], overrides: Partial<BuildParams> = {}): BuildParams {
  return {
    operation,
    rawBody: bytes('<Invoice/>'),
    rawContentType: 'application/xml',
    ...overrides,
  };
}

describe('buildRequest - me', () => {
  it('is a GET to /v1/me with no body', () => {
    const r = buildRequest({ operation: 'me' });
    expect(r).toEqual({ method: 'GET', path: '/v1/me', outputKind: 'json' });
  });
});

describe('buildRequest - generate', () => {
  it('posts JSON to /v1/generate and expects binary output', () => {
    const r = buildRequest(gen());
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/v1/generate');
    expect(r.contentType).toBe('application/json');
    expect(r.outputKind).toBe('binary');
    expect(r.jsonBody).toEqual({
      standard: 'xrechnung',
      output: 'xml',
      invoice: { number: 'INV-1' },
      verify: true,
    });
  });

  it('defaults output to xml and invoice to {}', () => {
    const r = buildRequest({ operation: 'generate', standard: 'xrechnung' });
    expect(r.jsonBody).toMatchObject({ output: 'xml', invoice: {} });
  });

  it('includes facturxProfile only for the Factur-X / ZUGFeRD family', () => {
    expect(buildRequest(gen({ standard: 'zugferd', output: 'pdf', facturxProfile: 'en16931' })).jsonBody)
      .toHaveProperty('facturxProfile', 'en16931');
    expect(buildRequest(gen({ standard: 'xrechnung', facturxProfile: 'en16931' })).jsonBody)
      .not.toHaveProperty('facturxProfile');
  });

  it('carries profile, template, and pdfTemplateId when set', () => {
    const r = buildRequest(gen({ profile: 'en16931', template: 'standard', pdfTemplateId: 'tpl-9' }));
    expect(r.jsonBody).toMatchObject({ profile: 'en16931', template: 'standard', pdfTemplateId: 'tpl-9' });
  });

  it('deep-merges advanced JSON into the body (advanced wins)', () => {
    const r = buildRequest(gen({ advanced: { pdfTemplateId: 'tpl-1', invoice: { note: 'x' } } }));
    expect(r.jsonBody).toHaveProperty('pdfTemplateId', 'tpl-1');
    expect(r.jsonBody!.invoice).toEqual({ number: 'INV-1', note: 'x' });
  });
});

describe('buildRequest - validate', () => {
  it('posts raw bytes to /v1/validate with a JSON result', () => {
    const r = buildRequest(raw('validate', { validateFormat: 'auto', franceCtc: true, rawContentType: 'application/pdf' }));
    expect(r.path).toBe('/v1/validate');
    expect(r.outputKind).toBe('json');
    expect(r.contentType).toBe('application/pdf');
    expect(r.rawBody).toBeInstanceOf(Uint8Array);
    expect(r.query).toEqual({ format: 'auto', franceCtc: true });
  });

  it('omits franceCtc when not set', () => {
    expect(buildRequest(raw('validate', { validateFormat: 'cii' })).query).toEqual({ format: 'cii' });
  });

  it('merges advanced JSON into the query', () => {
    expect(buildRequest(raw('validate', { validateFormat: 'auto', advanced: { strict: true } })).query)
      .toEqual({ format: 'auto', strict: true });
  });
});

describe('buildRequest - parse', () => {
  it('posts raw bytes to /v1/parse with a JSON result', () => {
    const r = buildRequest(raw('parse', { parseFormat: 'ubl' }));
    expect(r.path).toBe('/v1/parse');
    expect(r.outputKind).toBe('json');
    expect(r.query).toEqual({ format: 'ubl' });
  });
});

describe('buildRequest - convert', () => {
  it('posts raw bytes to /v1/convert with binary output and the target in the query', () => {
    const r = buildRequest(raw('convert', { sourceFormat: 'auto', targetFormat: 'ubl' }));
    expect(r.path).toBe('/v1/convert');
    expect(r.outputKind).toBe('binary');
    expect(r.query).toEqual({ sourceFormat: 'auto', targetFormat: 'ubl' });
  });

  it('includes targetProfile only for the Factur-X / ZUGFeRD family', () => {
    expect(buildRequest(raw('convert', { sourceFormat: 'auto', targetFormat: 'zugferd', targetProfile: 'en16931' })).query)
      .toHaveProperty('targetProfile', 'en16931');
    expect(buildRequest(raw('convert', { sourceFormat: 'auto', targetFormat: 'ubl', targetProfile: 'en16931' })).query)
      .not.toHaveProperty('targetProfile');
  });

  it('includes dropFranceCtcOverlay when set', () => {
    expect(buildRequest(raw('convert', { sourceFormat: 'cii', targetFormat: 'ubl', dropFranceCtcOverlay: true })).query)
      .toMatchObject({ dropFranceCtcOverlay: true });
  });
});

describe('sniffContentType', () => {
  it('detects PDF from the magic bytes', () => {
    expect(sniffContentType(bytes('%PDF-1.7\n...'))).toBe('application/pdf');
  });
  it('defaults to XML otherwise', () => {
    expect(sniffContentType(bytes('<?xml version="1.0"?>'))).toBe('application/xml');
  });
});

describe('mergeDeep', () => {
  it('merges nested objects without losing sibling keys', () => {
    expect(mergeDeep({ a: { x: 1 }, b: 2 }, { a: { y: 2 } })).toEqual({ a: { x: 1, y: 2 }, b: 2 });
  });

  it('overwrites scalars and arrays', () => {
    expect(mergeDeep({ a: 1, list: [1, 2] }, { a: 9, list: [3] })).toEqual({ a: 9, list: [3] });
  });

  it('ignores prototype-pollution keys in the source', () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"},"safe":"kept"}');
    const merged = mergeDeep({ existing: 1 }, malicious) as Record<string, unknown>;
    expect(merged.safe).toBe('kept');
    expect(merged.existing).toBe(1);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
  });
});
