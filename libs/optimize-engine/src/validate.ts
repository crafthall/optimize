// A small validator for the subset of JSON Schema (draft 2020-12) that record-v1 uses, so the engine needs no
// dependency: type (incl. type arrays), const, enum, pattern, minLength/maxLength, minimum/maximum,
// exclusiveMinimum, required, properties, additionalProperties: false, items, minItems/maxItems, oneOf and local
// `#/$defs/...` refs. A keyword outside the subset throws, so the schema cannot silently use one the validator ignores.

import { recordSchemaV1 } from './schema';

export interface SchemaError {
  /** JSON Pointer of the failing value (`""` is the root). */
  path: string;
  message: string;
}

type Schema = { readonly [k: string]: unknown };

const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'oneOf',
]);

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const matchesType = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
};
const ptr = (base: string, key: string | number): string => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const stringLength = (s: string): number => [...s].length;

const patternCache = new Map<string, RegExp>();
const regex = (p: string): RegExp => {
  let r = patternCache.get(p);
  if (!r) patternCache.set(p, (r = new RegExp(p, 'u')));
  return r;
};

/** Validates a value against a schema of the supported subset; `root` resolves `#/$defs/...` refs. */
export function validateAgainst(schema: Schema, value: unknown, root: Schema = schema, path = ''): SchemaError[] {
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) throw new Error(`schema keyword "${k}" is not supported by the Optimize validator`);
  const errors: SchemaError[] = [];
  const fail = (message: string, at = path): void => void errors.push({ path: at, message });

  if (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref'];
    const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
    const target = m ? (root['$defs'] as Record<string, Schema> | undefined)?.[m[1]!] : undefined;
    if (!target) throw new Error(`unresolvable $ref ${ref}`);
    errors.push(...validateAgainst(target, value, root, path));
  }
  if (Array.isArray(schema['oneOf'])) {
    const branches = (schema['oneOf'] as Schema[]).map((s) => validateAgainst(s, value, root, path));
    const passing = branches.filter((b) => b.length === 0).length;
    if (passing !== 1) {
      if (passing > 1) fail('matches more than one allowed shape');
      else errors.push(...branches.reduce((best, b) => (b.length < best.length ? b : best)));
    }
  }
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    if (!types.some((t) => matchesType(value, t))) {
      fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && value !== schema['const']) fail(`must be ${JSON.stringify(schema['const'])}`);
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(value)) fail(`must be one of ${(schema['enum'] as unknown[]).map((e) => JSON.stringify(e)).join(', ')}`);

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && stringLength(value) < schema['minLength']) fail(`shorter than ${schema['minLength']} characters`);
    if (typeof schema['maxLength'] === 'number' && stringLength(value) > schema['maxLength']) fail(`longer than ${schema['maxLength']} characters`);
    if (typeof schema['pattern'] === 'string' && !regex(schema['pattern']).test(value)) fail('does not match the required format');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('must be a finite number');
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) fail(`must be >= ${schema['minimum']}`);
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) fail(`must be <= ${schema['maximum']}`);
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) fail(`must be > ${schema['exclusiveMinimum']}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) fail(`needs at least ${schema['minItems']} items`);
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) fail(`allows at most ${schema['maxItems']} items`);
    if (schema['items'] && typeof schema['items'] === 'object') value.forEach((item, i) => errors.push(...validateAgainst(schema['items'] as Schema, item, root, ptr(path, i))));
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const req of (schema['required'] ?? []) as string[]) if (!(req in obj)) fail(`missing required field "${req}"`, ptr(path, req));
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validateAgainst(props[k], v, root, ptr(path, k)));
      else if (schema['additionalProperties'] === false) fail(`unknown field "${k}"`, ptr(path, k));
    }
  }
  return errors;
}

export type RecordKind = 'fixture' | 'comparison';

/**
 * Validates a record against schema v1. Picks the shape by `kind` so errors name the real problem instead of
 * "matches no shape"; a value without a known `kind` is checked against the full schema (oneOf).
 */
export function validateRecord(value: unknown): SchemaError[] {
  const kind = value && typeof value === 'object' && !Array.isArray(value) ? (value as { kind?: unknown }).kind : undefined;
  const root = recordSchemaV1 as unknown as Schema;
  if (kind === 'fixture' || kind === 'comparison') return validateAgainst({ $ref: `#/$defs/${kind}` }, value, root);
  const errors = validateAgainst(root, value, root);
  return errors.length ? errors : [{ path: '/kind', message: 'missing or unknown record kind' }];
}

/** Human-readable one-line summary of schema errors (for CLI exit-code-2 messages). */
export const formatErrors = (errors: readonly SchemaError[]): string => errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
