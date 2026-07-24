import { describe, expect, it } from 'vitest';
import { LIVE_GENERATE_PRESETS, LIVE_GENERATE_STANDARDS } from '../src/index';

describe('LIVE_GENERATE_PRESETS', () => {
  it('lists the public generate targets beliq.eu offers', () => {
    expect(LIVE_GENERATE_PRESETS.map((p) => p.id)).toEqual([
      'xrechnung',
      'factur-x',
      'zugferd',
      'peppol-bis',
      'nlcius',
    ]);
  });

  it('offers NLCIUS as a Peppol BIS profile, not a standalone standard', () => {
    const nlcius = LIVE_GENERATE_PRESETS.find((p) => p.id === 'nlcius');
    expect(nlcius).toMatchObject({ standard: 'peppol-bis', profile: 'netherlands-nlcius', output: 'xml' });
    // It is a profile, so it must not have leaked into the standards list.
    expect(LIVE_GENERATE_STANDARDS as readonly string[]).not.toContain('nlcius');
  });

  it('carries the Factur-X canonical profile on the hybrid-PDF preset', () => {
    expect(LIVE_GENERATE_PRESETS.find((p) => p.id === 'factur-x')).toMatchObject({
      standard: 'facturx',
      output: 'pdf',
      facturxProfile: 'en16931',
    });
  });

  it('maps every preset standard to a known live standard', () => {
    for (const preset of LIVE_GENERATE_PRESETS) {
      expect(LIVE_GENERATE_STANDARDS as readonly string[]).toContain(preset.standard);
    }
  });
});
