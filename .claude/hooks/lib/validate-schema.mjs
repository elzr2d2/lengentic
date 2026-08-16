/**
 * A deliberately small JSON Schema subset validator.
 *
 * Why not ajv: `.claude/` must remain deletable and must never become a runtime
 * dependency (MVP_PLAN.md §4, §29). A hook that only works after `pnpm install` has
 * succeeded is a hook that fails exactly when the repository is broken — which is when
 * you need it most. Node built-ins only.
 *
 * Supports the keywords `handoff.schema.json` actually uses:
 *   type, enum, required, additionalProperties, properties, items,
 *   minLength, minItems, maxItems, const, allOf, if/then
 *
 * Any other keyword is reported as an error against the schema itself, not skipped. A
 * subset validator that silently ignores what it does not understand is worse than no
 * validator: it reports PASS on constraints it never checked.
 */

const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'required',
  'additionalProperties',
  'properties',
  'items',
  'minLength',
  'minItems',
  'maxItems',
  'allOf',
  'if',
  'then',
  'description',
  'title',
  '$schema',
  '$id',
]);

/**
 * @param {unknown} value
 * @param {object} schema
 * @returns {string[]} human-readable errors; empty means valid
 */
export function validate(value, schema, path = '') {
  const errors = [];

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      errors.push(`${here(path)}: schema uses unsupported keyword "${keyword}"`);
    }
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${here(path)}: expected ${schema.type}, got ${describe(value)}`);
    return errors; // Further checks would cascade meaninglessly.
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${here(path)}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${here(path)}: ${JSON.stringify(value)} is not one of ${schema.enum.join(' | ')}`);
  }

  if (
    schema.minLength !== undefined &&
    typeof value === 'string' &&
    value.length < schema.minLength
  ) {
    errors.push(`${here(path)}: must not be empty`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        `${here(path)}: expected at least ${schema.minItems} item(s), got ${value.length}`,
      );
    }
    // `maxItems: 0` is how lane-handoff.schema.json says "DONE requires an empty
    // `unverified` bucket". Phrasing it as a count keeps the rule in the schema instead of
    // in an agent's judgement about whether a leftover criterion mattered.
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(
        `${here(path)}: expected at most ${schema.maxItems} item(s), got ${value.length}`,
      );
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${here(path)}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${here(path)}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validate(value[key], sub, path ? `${path}.${key}` : key));
    }
  }

  for (const branch of schema.allOf ?? []) {
    // if/then only. There is no `else` in handoff.schema.json and adding one silently
    // would be a validator that claims more coverage than it has.
    if (branch.if && branch.then) {
      if (validate(value, branch.if, path).length === 0) {
        errors.push(...validate(value, branch.then, path));
      }
    } else {
      errors.push(...validate(value, branch, path));
    }
  }

  return errors;
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'integer') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function here(path) {
  return path === '' ? '<root>' : path;
}
