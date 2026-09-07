import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Beliq } from '../src/index';
import type { Invoice } from '../src/index';

// Live smoke test against the real beliq API. Each call consumes one quota unit,
// so it is opt-in: set BELIQ_API_KEY (and optionally BELIQ_BASE_URL) to run it,
// otherwise the whole block is skipped. Excluded from the default `npm test`.
const apiKey = process.env.BELIQ_API_KEY;
const run = apiKey ? describe : describe.skip;

const invoice: Invoice = JSON.parse(
  readFileSync(new URL('../examples/invoice.json', import.meta.url), 'utf8'),
) as Invoice;

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
