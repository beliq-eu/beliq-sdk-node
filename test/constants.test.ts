import { describe, expect, it } from 'vitest';
import {
  LIVE_GENERATE_PRESETS,
  LIVE_GENERATE_STANDARDS,
  LIVE_PROFILES_BY_STANDARD,
  isProfileAllowedForStandard,
  profilesForStandard,
} from '../src/index';
import spec from '../openapi.json' with { type: 'json' };

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

describe('LIVE_PROFILES_BY_STANDARD', () => {
  // Whatever the map offers has to be a value the API's own schema accepts. The
  // spec enum is flat (it carries no per-standard rule), so this catches a typo
  // or a retired profile; the pairing itself is checked against the engine's
  // table by `npm run check:profiles`.
  type EnumSchema = { enum?: readonly string[]; anyOf?: readonly { enum?: readonly string[] }[] };
  type GenerateBodySpec = {
    paths: {
      '/v1/generate': {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { properties: Record<string, EnumSchema> } } };
          };
        };
      };
    };
  };

  const specProfiles: readonly string[] = (() => {
    const properties = (spec as unknown as GenerateBodySpec).paths['/v1/generate'].post.requestBody
      .content['application/json'].schema.properties;
    const profile = properties.profile;
    return profile.enum ?? (profile.anyOf ?? []).flatMap((member) => member.enum ?? []);
  })();

  it('covers exactly the live generate standards', () => {
    expect(Object.keys(LIVE_PROFILES_BY_STANDARD).sort()).toEqual(
      [...LIVE_GENERATE_STANDARDS].sort(),
    );
  });

  it('offers only profiles the API schema declares', () => {
    for (const [standard, profiles] of Object.entries(LIVE_PROFILES_BY_STANDARD)) {
      for (const profile of profiles) {
        expect(specProfiles, `${standard} -> ${profile}`).toContain(profile);
      }
    }
  });

  it('leaves no standard without a reachable profile', () => {
    for (const [standard, profiles] of Object.entries(LIVE_PROFILES_BY_STANDARD)) {
      expect(profiles.length, standard).toBeGreaterThan(0);
    }
  });

  it('withholds the Factur-X granularity profiles from XRechnung and Peppol BIS', () => {
    // The pair that shipped broken: every one of these is a 422 on those two
    // standards, so a flat profile dropdown offers four unreachable values.
    for (const profile of ['basicwl', 'en16931', 'extended', 'extended-ctc-fr']) {
      expect(isProfileAllowedForStandard('xrechnung', profile)).toBe(false);
      expect(isProfileAllowedForStandard('peppol-bis', profile)).toBe(false);
    }
  });

  it('keeps extended-ctc-fr off ZUGFeRD and on Factur-X', () => {
    // extended-ctc-fr is the AFNOR XP Z12-012 France CTC overlay; ZUGFeRD is the
    // German packaging of the same CII document and has no counterpart for it.
    expect(isProfileAllowedForStandard('zugferd', 'extended-ctc-fr')).toBe(false);
    expect(isProfileAllowedForStandard('facturx', 'extended-ctc-fr')).toBe(true);
  });

  it('keeps every preset profile legal for the standard it targets', () => {
    for (const preset of LIVE_GENERATE_PRESETS) {
      if (preset.profile) {
        expect(
          isProfileAllowedForStandard(preset.standard, preset.profile),
          `${preset.id}: ${preset.standard} + ${preset.profile}`,
        ).toBe(true);
      }
    }
  });

  it('defers to the API for a standard it does not carry', () => {
    expect(profilesForStandard('fatturapa')).toEqual([]);
    expect(isProfileAllowedForStandard('fatturapa', 'ordinaria')).toBe(true);
  });
});
