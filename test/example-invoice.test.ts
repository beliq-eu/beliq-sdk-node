import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { Invoice } from '../src/index';

// examples/invoice.json is the shape the README quickstart shows and the live
// smoke generates from, so it has to be a document the API actually accepts.
// `verify` defaults to true, and an invoice that satisfies plain EN 16931 still
// fails the XRechnung CIUS on rules no generic example carries. This shape was
// proven live on all four standards beliq offers (2026-09-06); the assertions
// below name the rule each field answers, so a future edit that drops one fails
// here instead of on the npm front page.

const invoice = JSON.parse(
  readFileSync(new URL('../examples/invoice.json', import.meta.url), 'utf8'),
) as Invoice;

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('examples/invoice.json', () => {
  it('carries the seller contact group BG-6 (BR-DE-2)', () => {
    expect(invoice.seller.contactName).toBeTruthy();
    expect(invoice.seller.phone).toBeTruthy();
  });

  it('carries payment instructions BG-16 (BR-DE-1)', () => {
    expect(invoice.paymentMeans?.typeCode).toBeTruthy();
  });

  it('carries a VAT breakdown BG-23 matching every line (BR-CO-18, BR-S-01)', () => {
    expect(invoice.taxSummary?.length).toBeGreaterThan(0);
    for (const line of invoice.lines) {
      expect(
        invoice.taxSummary!.some(
          (t) => t.vatCategoryCode === line.vatCategoryCode && t.vatRate === line.vatRate,
        ),
      ).toBe(true);
    }
  });

  it('gives both parties a Peppol electronic address (BT-34, BT-49)', () => {
    // `email` resolves as EAS `EM` on xrechnung but not on peppol-bis, where a
    // mailbox is not an SML-resolvable participant. An explicit endpoint is the
    // one rung every standard accepts.
    for (const party of [invoice.seller, invoice.buyer]) {
      expect(party.peppol?.schemeId).toBeTruthy();
      expect(party.peppol?.id).toBeTruthy();
    }
  });

  it('carries a buyerReference (BR-DE-15)', () => {
    expect(invoice.buyerReference).toBeTruthy();
  });

  it('states totals consistent with its lines (BR-CO-13, BR-CO-15)', () => {
    const net = invoice.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const tax = invoice.taxSummary!.reduce((sum, t) => sum + t.taxAmount, 0);
    expect(invoice.totalNetAmount).toBe(net);
    expect(invoice.totalTaxAmount).toBe(tax);
    expect(invoice.totalGrossAmount).toBe(net + tax);
  });
});

describe('README quickstart', () => {
  // npm renders this README as the package front page, so its invoice is the
  // first thing most people copy. It is written out rather than imported, so
  // nothing but this test keeps it in step with the fixture above.
  const quickstart = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Authentication'));

  it('shows the fields the XRechnung CIUS requires', () => {
    for (const field of ['buyerReference', 'contactName', 'phone', 'taxSummary', 'paymentMeans', 'peppol']) {
      expect(quickstart).toContain(field);
    }
  });
});
