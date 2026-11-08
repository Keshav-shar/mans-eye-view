'use strict';

// A tiny JSON-schema subset used to clean model output. It never throws: values that do not fit are
// dropped (array items, optional properties) or make the whole result null (missing required keys).
// Supported: type (object|array|string|number|integer|boolean), properties, required, items, enum,
// maxItems, maxLength, minimum, maximum. Unknown properties are removed.

const DROP = Symbol('drop');

function clean(schema, value) {
  if (!schema) return value;
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return DROP;
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (!(k in value)) continue;
        const v = clean(sub, value[k]);
        if (v !== DROP) out[k] = v;
      }
      for (const k of schema.required || []) if (!(k in out)) return DROP;
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return DROP;
      const out = [];
      for (const item of value) {
        const v = clean(schema.items, item);
        if (v !== DROP) out.push(v);
        if (schema.maxItems && out.length >= schema.maxItems) break;
      }
      return out;
    }
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number') return DROP;
      let s = String(value);
      if (schema.enum && !schema.enum.includes(s)) return DROP;
      if (schema.maxLength && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
    case 'number':
    case 'integer': {
      let n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return DROP;
      if (schema.type === 'integer') {
        if (!Number.isInteger(n)) return DROP;
      }
      if (schema.minimum != null && n < schema.minimum) n = schema.minimum;
      if (schema.maximum != null && n > schema.maximum) n = schema.maximum;
      if (schema.enum && !schema.enum.includes(n)) return DROP;
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return DROP;
    default:
      return value;
  }
}

function validate(schema, value) {
  const v = clean(schema, value);
  return v === DROP ? null : v;
}

module.exports = { validate };
