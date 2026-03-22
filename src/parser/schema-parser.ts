import * as yaml from 'js-yaml';
import { PlannerSchema, ColumnDef } from '../types';

export function parseSchema(source: string): PlannerSchema {
  const raw = yaml.load(source) as Record<string, any>;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid planner YAML: expected an object');
  }

  const schema: PlannerSchema = {
    type: raw.type || 'grid',
    title: raw.title || '',
    theme: raw.theme || 'soft',
    locale: raw.locale || 'ru',
    template: raw.template,
    columns: [],
    summary: raw.summary || [],
    data: raw.data || [],
  };

  // Copy all extra fields for template processing
  for (const key of Object.keys(raw)) {
    if (!(key in schema)) {
      schema[key] = raw[key];
    }
  }

  if (raw.columns && Array.isArray(raw.columns)) {
    schema.columns = raw.columns.map(parseColumn);
  }

  return schema;
}

function parseColumn(raw: any): ColumnDef {
  return {
    id: raw.id,
    label: raw.label || raw.id,
    type: raw.type || 'text',
    width: raw.width,
    frozen: raw.frozen || false,
    group: raw.group,
    options: raw.options,
    min: raw.min,
    max: raw.max,
    formula: raw.formula,
    format: raw.format,
    color_scale: raw.color_scale,
    highlight_if: raw.highlight_if,
  };
}
