import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(root, 'openapi.json');

interface ObjectSchema {
  properties?: Record<string, ObjectSchema>;
  required?: string[];
  items?: ObjectSchema;
  anyOf?: ObjectSchema[];
  oneOf?: ObjectSchema[];
  allOf?: ObjectSchema[];
  $ref?: string;
}

/** The schema of `data` in a 200 answer of POST /v1/parse. */
const parseData = (): ObjectSchema =>
  JSON.parse(readFileSync(vendored, 'utf8')).paths['/v1/parse'].post.responses['200'].content[
    'application/json'
  ].schema.properties.data;

/**
 * Every key the schema requires, at every depth, as a path from the schema's
 * root. Follows `properties`, `items` and the arms of `anyOf`, `oneOf` and
 * `allOf`. A `$ref` is not followed, so it throws instead of reading as
 * "requires nothing".
 */
function requiredPaths(schema: ObjectSchema, prefix = ''): string[] {
  if (schema.$ref) throw new Error(`${prefix}$ref: requiredPaths does not follow a reference`);
  const arms = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  return [
    ...(schema.required ?? []).map((key) => prefix + key),
    ...arms.flatMap((arm) => requiredPaths(arm, prefix)),
    ...(schema.items ? requiredPaths(schema.items, `${prefix.replace(/\.$/, '')}[].`) : []),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
      requiredPaths(child, `${prefix}${key}.`),
    ),
  ];
}

/** Where a value's keys depart from its schema: one it does not declare, or a required one left out. */
function departures(value: unknown, schema: ObjectSchema, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => departures(item, schema.items ?? {}, `${path}[${i}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  const declared = schema.properties ?? {};
  const held = value as Record<string, unknown>;
  return [
    ...Object.keys(held).filter((key) => !(key in declared)).map((key) => `${path}.${key} is not declared`),
    ...(schema.required ?? []).filter((key) => !(key in held)).map((key) => `${path}.${key} is missing`),
    ...Object.keys(held)
      .filter((key) => key in declared)
      .flatMap((key) => departures(held[key], declared[key], `${path}.${key}`)),
  ];
}

/**
 * The vendored spec has to be byte-identical to the copy the API generates and
 * to the one the Python SDK vendors: three copies of one contract, and a client
 * generated from a stale or differently-serialized one types the API wrongly.
 *
 * Byte equality across three languages only holds if every copy is serialized
 * the same way, and that is where it broke: `scripts/sync_spec.py` used
 * `json.dumps` at its default `ensure_ascii=True`, so the Python copy escaped
 * every non-ASCII character in a description and could never match, however
 * often it was re-synced.
 *
 * Re-serializing here and requiring a fixpoint catches that class without
 * needing the sibling checkout the SDK's CI does not have.
 */
describe('vendored openapi.json', () => {
  it('is exactly what scripts/sync-spec.mjs would write', () => {
    const text = readFileSync(vendored, 'utf8');
    const canonical = JSON.stringify(JSON.parse(text), null, 2) + '\n';
    expect(
      text === canonical,
      'openapi.json is not in canonical form, so it was written by something ' +
        'other than the current sync script. Run `node scripts/sync-spec.mjs` ' +
        'and commit the result.',
    ).toBe(true);
  });

  it('advertises a document version that is not the placeholder', () => {
    const spec = JSON.parse(readFileSync(vendored, 'utf8'));
    expect(spec.info.version).toBeTruthy();
    expect(spec.info.version).not.toBe('0.1.0');
  });

  /**
   * The `me.json` fixture is what every `me()` test parses, so it decides what
   * this SDK is proven to handle. It had drifted three fields behind the wire
   * (`livemode`, `org.rulesetChannel`, `quota.resetsAt`) while every test stayed
   * green, because a mock returns whatever the fixture says and nothing compared
   * it to the contract.
   *
   * Set equality against the spec's own `required` list, so a fixture that omits
   * a field fails as loudly as one that invents it. Top-level keys of `data`:
   * the nested objects are not walked, which is the same line the API
   * documentation's gate draws.
   */
  it('the me() fixture carries exactly the fields /v1/me returns', () => {
    const spec = JSON.parse(readFileSync(vendored, 'utf8'));
    const envelope =
      spec.paths['/v1/me'].get.responses['200'].content['application/json'].schema;
    const required: string[] = envelope.properties.data.required;
    expect(required.length).toBeGreaterThan(0);

    const fixtureData = JSON.parse(
      readFileSync(join(root, 'test', 'fixtures', 'me.json'), 'utf8'),
    ).data;
    expect(Object.keys(fixtureData).sort()).toEqual([...required].sort());
  });

  /**
   * A caller may read `invoice.lines` unguarded and no other field of a parsed
   * invoice. The comment on `ParseResult` says so, and this holds it to the
   * spec: `locationId.id` is required only inside a `delivery.locationId` that
   * is itself optional.
   */
  it('requires nothing of a parsed invoice but lines', () => {
    const invoice = parseData().properties?.invoice ?? {};
    expect(requiredPaths(invoice).sort()).toEqual(['delivery.locationId.id', 'lines']);
  });

  /**
   * `parse-fields-left-out.json` is what the parse test with absent fields
   * reads. A mock returns whatever the fixture says, so its keys are compared
   * with the spec here, at every depth: none that /v1/parse does not declare,
   * and none missing that it requires. Its values are not compared.
   */
  it('the parse fixture with fields left out has the keys /v1/parse declares', () => {
    const fixtureData = JSON.parse(
      readFileSync(join(root, 'test', 'fixtures', 'parse-fields-left-out.json'), 'utf8'),
    ).data;
    expect(departures(fixtureData, parseData(), 'data')).toEqual([]);
  });
});
