import * as yaml from 'js-yaml';
import { PlannerSchema } from '../types';

/**
 * Serialize a PlannerSchema back to YAML string.
 * Preserves field order for readability.
 */
export function serializeSchema(schema: PlannerSchema): string {
  const output: Record<string, any> = {};

  if (schema.template) {
    output.template = schema.template;
  } else {
    if (schema.type) output.type = schema.type;
  }
  if (schema.title) output.title = schema.title;
  if (schema.theme && schema.theme !== 'soft') output.theme = schema.theme;
  if (schema.locale && schema.locale !== 'ru') output.locale = schema.locale;

  // Copy template-specific fields
  const knownKeys = new Set(['type', 'title', 'theme', 'locale', 'template', 'columns', 'summary', 'data', '_subtables']);
  for (const key of Object.keys(schema)) {
    if (!knownKeys.has(key)) {
      output[key] = schema[key];
    }
  }

  if (schema.columns && schema.columns.length > 0 && !schema.template) {
    output.columns = schema.columns.map(col => {
      const c: Record<string, any> = { id: col.id, label: col.label, type: col.type };
      if (col.width) c.width = col.width;
      if (col.frozen) c.frozen = col.frozen;
      if (col.group) c.group = col.group;
      if (col.options) c.options = col.options;
      if (col.min !== undefined) c.min = col.min;
      if (col.max !== undefined) c.max = col.max;
      if (col.formula) c.formula = col.formula;
      if (col.format) c.format = col.format;
      if (col.color_scale) c.color_scale = col.color_scale;
      if (col.highlight_if) c.highlight_if = col.highlight_if;
      return c;
    });
  }

  if (schema.summary && schema.summary.length > 0 && !schema.template) {
    output.summary = schema.summary;
  }

  if (schema.data && schema.data.length > 0 && !schema.template) {
    output.data = schema.data;
  }

  return yaml.dump(output, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
}
