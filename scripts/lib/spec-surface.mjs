/**
 * "Does the vendored spec still cover everything the live API exposes?"
 *
 * Presence, never values. The question this answers is whether the vendored
 * copy has fallen BEHIND the deployed API, so it reports only surface the live
 * spec has and the vendored one lacks: a path, an operation, a parameter, a
 * response, a media type, a response header, a property, an enum value. A
 * vendored copy that is AHEAD of live, which is every moment between merging a
 * spec change and deploying it, yields nothing.
 *
 * The previous implementation compared the documents value by value, so a
 * narrowed type (`plan.name` going `string | null` to `string`) and a reworded
 * description both counted as "behind". It honoured the directional contract
 * only for pure additions, and it turned `main` red in this repo and in
 * beliq-sdk-python the moment a merged-but-undeployed change landed, which is
 * precisely the case the check exists to tolerate. `info` had already been
 * excluded wholesale for the same reason, one field at a time instead of at the
 * mechanism.
 *
 * A changed type is a divergence rather than missing surface, and nothing here
 * reports it.
 *
 * `descriptionsDiverging` answers the second question, "does the vendored copy
 * still say what the deployed API says", for description text only. That one was
 * left to `test/spec-vendoring.test.ts`, which does not ask it: that test
 * re-serializes this repo's copy and compares it with itself, so it catches a
 * serialization change and nothing about the API. Two of the five spec syncs
 * this repo made between 2026-09-29 and 2026-10-03 changed nothing but
 * description text, and a human found both of them:
 * https://github.com/beliq-eu/beliq-sdk-node/pull/59 and
 * https://github.com/beliq-eu/beliq-sdk-node/pull/69.
 *
 * Kept in step with `beliq-sdk-python/scripts/_spec_surface.py`; the two are
 * expected to report the same paths for the same pair of documents.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every enum value a schema can produce, including through union arms.
 *
 * The API models a closed string set as an `anyOf` of single-value enums, so
 * a newly accepted format or standard reaches a client as a new arm rather than
 * a new member of one `enum`. Flattening both sides to a value set catches that
 * addition, while a narrowing (dropping a `null` arm) is a subset and stays
 * quiet.
 */
function enumValues(schema, into = new Set()) {
  if (!isObject(schema)) return into;
  for (const value of schema.enum ?? []) into.add(JSON.stringify(value));
  for (const arm of schema.anyOf ?? []) enumValues(arm, into);
  return into;
}

/**
 * Union arms carrying structure of their own would need arm-to-arm matching,
 * which this deliberately does not attempt: every arm in the spec today is a
 * single-value enum or a bare `{ type }`, so `enumValues` is complete. If that
 * changes, the check would silently stop covering the new shape, so it reports
 * instead. Going quietly blind is the failure this rewrite exists to remove.
 */
function unhandledArms(schema, path, missing) {
  for (const [i, arm] of (schema.anyOf ?? []).entries()) {
    if (isObject(arm) && (arm.properties || arm.$ref || arm.items)) {
      missing.push(`${path}.anyOf[${i}] carries structure this check cannot compare`);
    }
  }
}

/**
 * A `$ref` is compared by target and not followed. That keeps the walk finite
 * over the spec's one self-referential schema (`InvoiceLine.subLines`) without
 * a visited-set, and the referenced schemas are still walked once each through
 * `components.schemas`.
 */
function compareSchema(live, vend, path, missing) {
  if (!isObject(live)) return;
  if (!isObject(vend)) {
    missing.push(path);
    return;
  }

  if (live.$ref !== undefined) {
    if (vend.$ref !== live.$ref) missing.push(`${path}.$ref -> ${live.$ref}`);
    return;
  }

  unhandledArms(live, path, missing);

  const vendEnums = enumValues(vend);
  for (const value of enumValues(live)) {
    if (!vendEnums.has(value)) missing.push(`${path}.enum ${value}`);
  }

  for (const [name, sub] of Object.entries(live.properties ?? {})) {
    compareSchema(sub, vend.properties?.[name], `${path}.${name}`, missing);
  }

  if (live.items) compareSchema(live.items, vend.items, `${path}[]`, missing);
  if (isObject(live.additionalProperties)) {
    compareSchema(live.additionalProperties, vend.additionalProperties, `${path}{*}`, missing);
  }
}

function compareContent(live, vend, path, missing) {
  for (const [mediaType, body] of Object.entries(live ?? {})) {
    const vendBody = vend?.[mediaType];
    if (!vendBody) {
      missing.push(`${path}.${mediaType}`);
      continue;
    }
    compareSchema(body.schema, vendBody.schema, `${path}.${mediaType}`, missing);
  }
}

function compareOperation(live, vend, path, missing) {
  for (const param of live.parameters ?? []) {
    const match = (vend.parameters ?? []).find((p) => p.name === param.name && p.in === param.in);
    if (!match) missing.push(`${path}.parameters.${param.in}.${param.name}`);
    else compareSchema(param.schema, match.schema, `${path}.parameters.${param.name}`, missing);
  }

  if (live.requestBody) {
    if (!vend.requestBody) missing.push(`${path}.requestBody`);
    else compareContent(live.requestBody.content, vend.requestBody.content, `${path}.requestBody`, missing);
  }

  for (const [status, response] of Object.entries(live.responses ?? {})) {
    const vendResponse = vend.responses?.[status];
    if (!vendResponse) {
      missing.push(`${path}.responses.${status}`);
      continue;
    }
    compareContent(response.content, vendResponse.content, `${path}.responses.${status}`, missing);
    for (const header of Object.keys(response.headers ?? {})) {
      if (!vendResponse.headers?.[header]) {
        missing.push(`${path}.responses.${status}.headers.${header}`);
      }
    }
  }
}

/** Surface the live spec exposes that the vendored copy does not. */
export function surfaceMissingFrom(live, vend) {
  const missing = [];

  for (const [route, item] of Object.entries(live.paths ?? {})) {
    const vendItem = vend.paths?.[route];
    if (!vendItem) {
      missing.push(`paths.${route}`);
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      const vendOperation = vendItem[method];
      if (!vendOperation) {
        missing.push(`paths.${route}.${method}`);
        continue;
      }
      compareOperation(operation, vendOperation, `paths.${route}.${method}`, missing);
    }
  }

  for (const [name, schema] of Object.entries(live.components?.schemas ?? {})) {
    compareSchema(schema, vend.components?.schemas?.[name], `components.schemas.${name}`, missing);
  }

  for (const name of Object.keys(live.components?.securitySchemes ?? {})) {
    if (!vend.components?.securitySchemes?.[name]) {
      missing.push(`components.securitySchemes.${name}`);
    }
  }

  return missing;
}

/**
 * Every `description` string in the document, by its path.
 *
 * The path is the raw document path, not the collapsed one `surfaceMissingFrom`
 * reports: this walk makes no distinction between a schema, a response and the
 * document's own `info`, because every one of them is text the SDK ships.
 */
function descriptions(node, path, into) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => descriptions(value, `${path}[${index}]`, into));
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') into.set(path, value);
      else descriptions(value, path ? `${path}.${key}` : key, into);
    }
  }
  return into;
}

/**
 * Every `description` the two documents do not spell identically.
 *
 * Unlike `surfaceMissingFrom` this is NOT directional, because prose carries no
 * direction: nothing in the pair says which side is newer. Both directions are
 * reported and both mean the same thing, that the vendored copy and the deployed
 * API disagree about what the API says. The remedy differs: re-sync, or deploy
 * the spec change the vendored copy was synced from.
 *
 * A description is a contract, not decoration. It is where an operation declares
 * which field to branch on, and the vendored copy is published to npm, so a
 * description this SDK ships is a claim beliq makes. `summary` and `title` are
 * deliberately not compared: they label, they do not instruct, and comparing
 * every string is the value-by-value walk this module exists to replace.
 */
export function descriptionsDiverging(live, vend) {
  const liveText = descriptions(live, '', new Map());
  const vendText = descriptions(vend, '', new Map());

  const diverging = [];
  for (const path of [...new Set([...liveText.keys(), ...vendText.keys()])].sort()) {
    if (!vendText.has(path)) diverging.push(`${path}: only the live spec carries it`);
    else if (!liveText.has(path)) diverging.push(`${path}: only the vendored copy carries it`);
    else if (liveText.get(path) !== vendText.get(path)) diverging.push(`${path}: the text differs`);
  }
  return diverging;
}
