import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { surfaceMissingFrom } from '../scripts/lib/spec-surface.mjs';

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
    // The case that turned main red: bq-api#262 narrowed plan.name and reworded
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
