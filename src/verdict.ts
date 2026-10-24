// Display text for a verdict and for a convert answer, exposed at `@beliq/sdk/helpers` so the
// tools that print one (beliq-cli, beliq-mcp, the connectors) say it in the same words. Each line
// restates what the API sent and claims no check depth the API did not state.
import type { ValidationResult } from './types';

/**
 * Printed where the API sent no badge label for a verdict. It names no depth,
 * so it claims none.
 */
export const DEPTH_NOT_STATED = 'check depth not stated';

/**
 * The `ruleId` of the API's own `info` entry in `warnings` that explains
 * `franceCtcBlockingRuleIds` (https://docs.beliq.eu/api-reference/validate/).
 */
export const FRANCE_CTC_BLOCKING_FINDING_RULE_ID = 'FRANCE_CTC_FINDINGS_BLOCK_TRANSMISSION';

/**
 * What a PDF that `convert()` returns for a `facturx` or `zugferd` target is, in the words of
 * https://docs.beliq.eu/api-reference/convert/. No documented field says which of the two paths
 * ran, so the line names both. The test-key half is why it never says "veraPDF checked this
 * file": the watermark comes after the check, and the watermarked file does not pass it.
 */
export const CONVERT_PDF_LINE =
  'The PDF is the one sent, with only its annotation flags normalised for PDF/A, when its embedded XML already is the target: that XML was checked and the PDF container was not. ' +
  'Otherwise it is that PDF re-wrapped around the converted XML, returned only after veraPDF passed it against PDF/A-3b. ' +
  'With a test key the PDF is watermarked last, after any veraPDF check. ' +
  'Detail: https://docs.beliq.eu/api-reference/convert/#a-pdf-sent-for-a-zugferd-or-factur-x-target';

/**
 * The verdict in the API's own words. `verified: false` means no ruleset ran
 * (generate with verify off), so neither word applies.
 */
export function verdictWord(result: Pick<ValidationResult, 'valid' | 'verified'>): string {
  if (result.verified === false) return 'NOT VALIDATED';
  return result.valid ? 'VALID' : 'INVALID';
}

/** The badge label the API sent, as it came, or the mark for none. */
export function checkDepth(result: Pick<ValidationResult, 'verificationBadgeLabel'>): string {
  return result.verificationBadgeLabel ?? DEPTH_NOT_STATED;
}

/** The France CTC rule ids the API reports as ending a transmission; empty when it sent none. */
export function franceBlockingRuleIds(result: Pick<ValidationResult, 'franceCtcBlockingRuleIds'>): string[] {
  return result.franceCtcBlockingRuleIds ?? [];
}

/**
 * The lines that explain a France CTC block: the API's own message for it when
 * the result carries one, and the rule ids unless that message already names
 * every one of them.
 */
export function franceBlockLines(
  result: Pick<ValidationResult, 'franceCtcBlockingRuleIds' | 'warnings'>,
): string[] {
  const ids = franceBlockingRuleIds(result);
  if (ids.length === 0) return [];
  // A JavaScript caller can pass a partial result with no `warnings`.
  const entry = (result.warnings ?? []).find((w) => w.ruleId === FRANCE_CTC_BLOCKING_FINDING_RULE_ID);
  const idLine = `France CTC blocking rule ids: ${ids.join(', ')}`;
  if (!entry) return [idLine];
  const named = new Set(entry.message.split(/[^A-Za-z0-9_-]+/));
  return ids.every((id) => named.has(id)) ? [entry.message] : [entry.message, idLine];
}

/**
 * The embedded file's name comes from the uploaded PDF. Control and format
 * characters, line separators and the double quote are replaced, so a crafted
 * name can neither start a line of its own nor close the quotes around it.
 */
function printable(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"]/gu, '?');
}

/** What the API says about a PDF input: which embedded file was read, and that the PDF was not checked. */
export function pdfInputLine(result: Pick<ValidationResult, 'pdfInput'>): string | undefined {
  const pdf = result.pdfInput;
  if (!pdf) return undefined;
  const name = pdf.attachmentName ? ` "${printable(pdf.attachmentName)}"` : '';
  const others =
    pdf.attachmentCandidates > 1
      ? ` ${pdf.attachmentCandidates} embedded files could be taken for the invoice, and nothing compared them.`
      : '';
  return (
    `PDF input: the verdict is about the embedded XML${name} (found by ${pdf.attachmentFoundBy}). ` +
    `The PDF itself was not checked.${others}`
  );
}

/** Which ruleset channel the API says served the request, when the result names one. */
export function rulesetChannelLine(
  result: Pick<ValidationResult, 'rulesetChannel' | 'rulesetFellBack' | 'rulesetSunsetsOn'>,
): string | undefined {
  if (!result.rulesetChannel) return undefined;
  const fellBack = result.rulesetFellBack ? ', which had nothing to reach, so the latest ruleset ran' : '';
  const sunset = result.rulesetSunsetsOn ? `; the retained ruleset is served until ${result.rulesetSunsetsOn}` : '';
  return `Ruleset channel: ${result.rulesetChannel}${fellBack}${sunset}`;
}
