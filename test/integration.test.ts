import { beforeAll, describe, expect, it } from 'vitest';
import { Beliq } from '../src/index';
import type { Invoice } from '../src/index';

// Live smoke test against the real beliq API. Each call consumes one quota unit,
// so it is opt-in: set BELIQ_API_KEY (and optionally BELIQ_BASE_URL) to run it,
// otherwise the whole block is skipped. Excluded from the default `npm test`.
const apiKey = process.env.BELIQ_API_KEY;
const run = apiKey ? describe : describe.skip;

const invoice: Invoice = {
  number: 'IT-2026-001',
  issueDate: '2026-01-15',
  dueDate: '2026-02-14',
  currencyCode: 'EUR',
  buyerReference: 'LEITWEG-01',
  seller: {
    name: 'Seller GmbH',
    vatId: 'DE123456789',
    address: { street: 'Hauptstrasse 1', city: 'Berlin', postalCode: '10115', countryCode: 'DE' },
  },
  buyer: {
    name: 'Buyer GmbH',
    vatId: 'DE987654321',
    address: { street: 'Marktplatz 2', city: 'Munich', postalCode: '80331', countryCode: 'DE' },
  },
  lines: [
    { description: 'Consulting', quantity: 10, unitCode: 'HUR', unitPrice: 100, lineTotal: 1000, vatRate: 19, vatCategoryCode: 'S' },
  ],
  taxSummary: [{ vatCategoryCode: 'S', vatRate: 19, taxableAmount: 1000, taxAmount: 190 }],
  totalNetAmount: 1000,
  totalTaxAmount: 190,
  totalGrossAmount: 1190,
};

run('beliq live API', () => {
  const beliq = new Beliq({
    apiKey: apiKey!,
    baseUrl: process.env.BELIQ_BASE_URL,
  });
  let xrechnungXml: string;

  beforeAll(async () => {
    const account = await beliq.me();
    expect(account.org.id).toBeTruthy();

    const generated = await beliq.generate({ standard: 'xrechnung', verify: true, invoice });
    expect(generated.contentType).toContain('application/xml');
    expect(generated.meta.schematronVersion).toBeTruthy();
    expect(generated.xml).toBeDefined();
    expect(generated.xml!.trimStart().startsWith('<')).toBe(true);
    xrechnungXml = generated.xml!;
  });

  it('validates the generated XRechnung', async () => {
    const result = await beliq.validate(xrechnungXml, { format: 'auto' });
    expect(typeof result.valid).toBe('boolean');
    expect(result.format).toBeDefined();
  });

  it('parses the generated XRechnung', async () => {
    const result = await beliq.parse(xrechnungXml, { format: 'auto' });
    expect(result.format).toBeDefined();
    expect(result.invoice).toBeDefined();
  });

  it('converts the generated XRechnung to UBL', async () => {
    const result = await beliq.convert(xrechnungXml, { sourceFormat: 'auto', targetFormat: 'ubl' });
    expect(result.meta.targetFormat).toBe('ubl');
    expect(result.bytes.length).toBeGreaterThan(0);
  });
});
