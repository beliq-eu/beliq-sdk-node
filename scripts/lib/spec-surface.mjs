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
 * A changed type or a reworded description is a divergence rather than missing
 * surface, and divergence from beliq-api's own copy is what
 * `test/spec-vendoring.test.ts` asserts.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every enum value a schema can produce, including through union arms.
 *
 * beliq-api models a closed string set as an `anyOf` of single-value enums, so
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
