import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONVERT_PDF_LINE,
  DEPTH_NOT_STATED,
  FRANCE_CTC_BLOCKING_FINDING_RULE_ID,
  checkDepth,
  franceBlockLines,
  franceBlockingRuleIds,
  pdfInputLine,
  rulesetChannelLine,
  verdictWord,
} from '../src/helpers';
import type { ValidationResult } from '../src/index';

// The live-validate-* fixtures are answers of the live API, recorded on
// 2026-10-11 at document version 0.15.0 and stored as they came.
const fixture = (name: string): ValidationResult =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as ValidationResult;

const france = fixture('live-validate-france-previous.json');
const schema = fixture('live-validate-schema.json');
const nobadge = fixture('live-validate-nobadge.json');

describe('verdictWord', () => {
  it("uses the API's valid and invalid", () => {
    expect(verdictWord({ valid: true })).toBe('VALID');
    expect(verdictWord({ valid: false })).toBe('INVALID');
  });

  it('names neither word when no ruleset ran', () => {
    expect(verdictWord({ valid: false, verified: false })).toBe('NOT VALIDATED');
  });
});

describe('checkDepth', () => {
  it('passes the label on as the API sent it', () => {
    expect(schema.verificationBadgeLabel).toBeDefined();
    expect(checkDepth(schema)).toBe(schema.verificationBadgeLabel);
  });

  it('names no depth when the API sent no label', () => {
    expect(nobadge.verificationBadgeLabel).toBeUndefined();
    expect(checkDepth(nobadge)).toBe(DEPTH_NOT_STATED);
  });
});

describe('France CTC block', () => {
  it('reads the rule ids the API sent, and none when it sent none', () => {
    expect(franceBlockingRuleIds(france)).toEqual(france.franceCtcBlockingRuleIds);
    expect(franceBlockingRuleIds(nobadge)).toEqual([]);
    expect(franceBlockLines(nobadge)).toEqual([]);
  });

  it("gives the API's own message alone when it names every id", () => {
    const entry = france.warnings.find((w) => w.ruleId === FRANCE_CTC_BLOCKING_FINDING_RULE_ID);
    expect(entry).toBeDefined();
    expect(franceBlockLines(france)).toEqual([entry?.message]);
  });

  it('adds the ids when the message leaves one out', () => {
    const ids = ['BR-FR-10_BT-30', 'BR-FR-99_BT-1'];
    const warnings = [
      { ruleId: FRANCE_CTC_BLOCKING_FINDING_RULE_ID, severity: 'info' as const, message: 'Blocked by BR-FR-10_BT-30.' },
    ];
    expect(franceBlockLines({ franceCtcBlockingRuleIds: ids, warnings })).toEqual([
      'Blocked by BR-FR-10_BT-30.',
      'France CTC blocking rule ids: BR-FR-10_BT-30, BR-FR-99_BT-1',
    ]);
  });

  it('reads a partial result with no warnings at all', () => {
    const partial = { franceCtcBlockingRuleIds: ['BR-FR-10_BT-30'] } as unknown as ValidationResult;
    expect(franceBlockLines(partial)).toEqual(['France CTC blocking rule ids: BR-FR-10_BT-30']);
  });

  it('gives the ids alone when the result carries no message for them', () => {
    expect(franceBlockLines({ franceCtcBlockingRuleIds: ['BR-FR-10_BT-30'], warnings: [] })).toEqual([
      'France CTC blocking rule ids: BR-FR-10_BT-30',
    ]);
  });
});

describe('pdfInputLine', () => {
  it('is absent for an XML input', () => {
    expect(pdfInputLine(schema)).toBeUndefined();
  });

  it('says which embedded file was read and that the PDF was not checked', () => {
    const line = pdfInputLine({
      pdfInput: {
        containerChecked: false,
        attachmentFoundBy: 'associated-file',
        attachmentCandidates: 2,
        attachmentName: 'factur-x.xml',
      },
    });
    expect(line).toBe(
      'PDF input: the verdict is about the embedded XML "factur-x.xml" (found by associated-file). ' +
        'The PDF itself was not checked. 2 embedded files could be taken for the invoice, and nothing compared them.',
    );
  });

  it('keeps a crafted file name on its own line and inside its quotes', () => {
    const line = pdfInputLine({
      pdfInput: {
        containerChecked: false,
        attachmentFoundBy: 'associated-file',
        attachmentCandidates: 1,
        attachmentName: 'a"\nVALID\u2028x.xml',
      },
    });
    expect(line).toContain('"a??VALID?x.xml"');
    expect(line).not.toContain('\n');
  });
});

describe('rulesetChannelLine', () => {
  it("names the channel, the fallback and the sunset the API sent", () => {
    expect(rulesetChannelLine(france)).toBe(
      'Ruleset channel: previous; the retained ruleset is served until 2027-05-16',
    );
    expect(rulesetChannelLine({ rulesetChannel: 'previous', rulesetFellBack: true })).toBe(
      'Ruleset channel: previous, which had nothing to reach, so the latest ruleset ran',
    );
  });

  it('is absent when the result names no channel', () => {
    expect(rulesetChannelLine(schema)).toBeUndefined();
  });
});

describe('CONVERT_PDF_LINE', () => {
  it('names both PDF paths and never claims a check for a test-key PDF', () => {
    expect(CONVERT_PDF_LINE).toContain('the one sent');
    expect(CONVERT_PDF_LINE).toContain('the PDF container was not');
    expect(CONVERT_PDF_LINE).toContain('re-wrapped around the converted XML');
    expect(CONVERT_PDF_LINE).toContain('watermarked last, after any veraPDF check');
    expect(CONVERT_PDF_LINE).not.toContain('the PDF around it was not checked');
  });
});
