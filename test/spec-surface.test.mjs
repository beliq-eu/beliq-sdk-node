import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { descriptionsDiverging, surfaceMissingFrom } from '../scripts/lib/spec-surface.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = () => JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));

/**
 * The drift check answers one question: has the vendored spec fallen behind the
 * deployed API? Its previous implementation answered a different one, "do the
 * two documents differ", and nothing here caught that because nothing here
 * existed. These cases are the contract, stated as behaviour in both
 * directions.
 *
 * The vendored copy stands in for both sides: a mutated clone plays the live
 * spec, so every case says exactly what changed.
 */
describe('surfaceMissingFrom', () => {
  const vendored = spec();
  const live = (mutate) => {
    const clone = spec();
    mutate(clone);
    return clone;
  };
  const meData = (s) =>
    s.paths['/v1/me'].get.responses['200'].content['application/json'].schema.properties.data;
  const formatParam = (s) => s.paths['/v1/validate'].post.parameters.find((p) => p.name === 'format');

  it('is silent when the two are identical', () => {
    expect(surfaceMissingFrom(spec(), vendored)).toEqual([]);
  });

  describe('reports surface the vendored copy is missing', () => {
    it('a new path', () => {
      const missing = surfaceMissingFrom(
        live((s) => { s.paths['/v1/brandnew'] = { get: { responses: {} } }; }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/brandnew']);
    });

    it('a new operation on a known path', () => {
      const missing = surfaceMissingFrom(
        live((s) => { s.paths['/v1/me'].delete = { responses: {} }; }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/me.delete']);
    });

    it('a new response status', () => {
      const missing = surfaceMissingFrom(
        live((s) => { s.paths['/v1/me'].get.responses['418'] = { description: 'x' }; }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/me.get.responses.418']);
    });

    it('a new media type on a known response', () => {
      const missing = surfaceMissingFrom(
        live((s) => {
          s.paths['/v1/me'].get.responses['200'].content['application/xml'] = { schema: { type: 'string' } };
        }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/me.get.responses.200.application/xml']);
    });

    it('a new response header', () => {
      const missing = surfaceMissingFrom(
        live((s) => {
          const res = s.paths['/v1/me'].get.responses['200'];
          res.headers = { ...(res.headers ?? {}), 'x-brand-new': { schema: { type: 'string' } } };
        }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/me.get.responses.200.headers.x-brand-new']);
    });

    it('a new response property', () => {
      const missing = surfaceMissingFrom(
        live((s) => { meData(s).properties.seats = { type: 'integer' }; }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/me.get.responses.200.application/json.data.seats']);
    });

    it('a new nested property', () => {
      const missing = surfaceMissingFrom(
        live((s) => { meData(s).properties.quota.properties.carriedOver = { type: 'integer' }; }),
        vendored,
      );
      expect(missing).toEqual([
        'paths./v1/me.get.responses.200.application/json.data.quota.carriedOver',
      ]);
    });

    it('a new query parameter', () => {
      const missing = surfaceMissingFrom(
        live((s) => {
          s.paths['/v1/validate'].post.parameters.push({
            name: 'brandNew', in: 'query', schema: { type: 'string' },
          });
        }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/validate.post.parameters.query.brandNew']);
    });

    // A closed string set is an `anyOf` of single-value enums, so a newly
    // accepted format arrives as a new arm rather than a new `enum` member.
    it('a newly accepted enum value, arriving as a union arm', () => {
      const missing = surfaceMissingFrom(
        live((s) => { formatParam(s).schema.anyOf.push({ type: 'string', enum: ['brandnew-format'] }); }),
        vendored,
      );
      expect(missing).toEqual(['paths./v1/validate.post.parameters.format.enum "brandnew-format"']);
    });
  });

  describe('stays silent when the vendored copy is merely ahead or different', () => {
    // The case that turned main red: an API change narrowed plan.name and reworded
    // a description, and both read as "behind" until this rewrite.
    it('a type the vendored copy narrowed', () => {
      const missing = surfaceMissingFrom(
        live((s) => {
          meData(s).properties.plan.properties.name = { anyOf: [{ type: 'string' }, { type: 'null' }] };
        }),
        vendored,
      );
      expect(missing).toEqual([]);
    });

    it('a reworded description', () => {
      const missing = surfaceMissingFrom(
        live((s) => {
          meData(s).properties.quota.properties.resetsAt.description = 'something else entirely';
          s.paths['/v1/me'].get.summary = 'a different summary';
        }),
        vendored,
      );
      expect(missing).toEqual([]);
    });

    it('a field the vendored copy added ahead of the deploy', () => {
      const missing = surfaceMissingFrom(
        live((s) => { delete meData(s).properties.livemode; }),
        vendored,
      );
      expect(missing).toEqual([]);
    });

    it('a path the vendored copy added ahead of the deploy', () => {
      const missing = surfaceMissingFrom(
        live((s) => { delete s.paths['/v1/rulesets']; }),
        vendored,
      );
      expect(missing).toEqual([]);
    });

    // `info.version` is replaced on a bump, not added to, so a vendored copy
    // legitimately ahead of live used to read as behind. It needed a dedicated
    // exclusion under the old value-comparing walk; presence-only needs none,
    // because `info` carries no surface to be present.
    it('a version bump the vendored copy is ahead of', () => {
      const missing = surfaceMissingFrom(
        live((s) => { s.info.version = '0.0.1-ancient'; s.info.description = 'old'; }),
        vendored,
      );
      expect(missing).toEqual([]);
    });
  });

  // Silence has to mean "covered", never "did not look". Every arm in the spec
  // today is a single-value enum or a bare `{ type }`; one carrying structure
  // would need arm-to-arm matching this does not do, so it says so.
  it('reports a union arm it cannot compare rather than skipping it', () => {
    const missing = surfaceMissingFrom(
      live((s) => { formatParam(s).schema.anyOf.push({ properties: { nested: { type: 'string' } } }); }),
      vendored,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/carries structure this check cannot compare/);
  });

  it('terminates on the spec\'s self-referential schema', () => {
    // InvoiceLine.subLines refs InvoiceLine. A `$ref` is compared by target and
    // not followed, which is what keeps this finite without a visited-set.
    expect(surfaceMissingFrom(spec(), vendored)).toEqual([]);
    const missing = surfaceMissingFrom(
      live((s) => {
        s.components.schemas.InvoiceLine.properties.subLines.items.$ref = '#/components/schemas/Other';
      }),
      vendored,
    );
    expect(missing).toEqual([
      'components.schemas.InvoiceLine.subLines[].$ref -> #/components/schemas/Other',
    ]);
  });
});

/**
 * `surfaceMissingFrom` is silent on description text by design, and nothing else
 * compared it: the vendoring test re-serializes the vendored copy and compares
 * it with itself. These cases are that half of the contract.
 */
describe('descriptionsDiverging', () => {
  const vendored = spec();
  const live = (mutate) => {
    const clone = spec();
    mutate(clone);
    return clone;
  };
  const meData = (s) =>
    s.paths['/v1/me'].get.responses['200'].content['application/json'].schema.properties.data;
  const meDataPath =
    'paths./v1/me.get.responses.200.content.application/json.schema.properties.data';

  it('is silent when the two are identical', () => {
    expect(descriptionsDiverging(spec(), vendored)).toEqual([]);
  });

  it('reports a reworded description the surface check ignores', () => {
    const mutated = live((s) => {
      meData(s).properties.quota.properties.resetsAt.description = 'something else';
    });
    expect(surfaceMissingFrom(mutated, vendored)).toEqual([]);
    expect(descriptionsDiverging(mutated, vendored)).toEqual([
      `${meDataPath}.properties.quota.properties.resetsAt: the text differs`,
    ]);
  });

  it('reports a description only the live spec carries', () => {
    const mutated = live((s) => {
      meData(s).properties.plan.description = 'the plan this key draws on';
    });
    expect(descriptionsDiverging(mutated, vendored)).toEqual([
      `${meDataPath}.properties.plan: only the live spec carries it`,
    ]);
  });

  it('reports a description only the vendored copy carries', () => {
    // Which is also what a vendored copy synced ahead of the deploy looks like.
    // Prose carries no direction, so this is reported and the message says both
    // readings; the surface check stays directional.
    const mutated = live((s) => {
      delete meData(s).properties.livemode.description;
    });
    expect(surfaceMissingFrom(mutated, vendored)).toEqual([]);
    expect(descriptionsDiverging(mutated, vendored)).toEqual([
      `${meDataPath}.properties.livemode: only the vendored copy carries it`,
    ]);
  });

  it("reports the document's own description and a tag description", () => {
    // `info` is excluded from the surface walk wholesale, and this SDK publishes
    // the document, so its own blurb is a claim nothing else compares.
    const mutated = live((s) => {
      s.info.description = 'a different blurb';
      s.tags[0].description = 'a different tag line';
    });
    expect(descriptionsDiverging(mutated, vendored)).toEqual([
      'info: the text differs',
      'tags[0]: the text differs',
    ]);
  });

  it('is silent on a reworded summary', () => {
    // Only `description` is compared. A summary labels an operation, it does not
    // instruct a caller, and comparing every string is the value-by-value walk
    // surfaceMissingFrom exists to replace.
    const mutated = live((s) => { s.paths['/v1/me'].get.summary = 'a different summary'; });
    expect(descriptionsDiverging(mutated, vendored)).toEqual([]);
  });
});
