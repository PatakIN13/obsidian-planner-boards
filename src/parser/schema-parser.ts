import * as yaml from 'js-yaml';
import { PlannerSchema, ColumnDef } from '../types';

export function parseSchema(source: string): PlannerSchema {
  const raw = yaml.load(source) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid planner YAML: expected an object');
  }

  const schema: PlannerSchema = {
    type: (raw.type as string) || 'grid',
    title: (raw.title as string) || '',
    theme: (raw.theme as string) || 'soft',
    locale: (raw.locale as string) || 'ru',
    template: raw.template as string | undefined,
    columns: [],
    summary: (raw.summary as PlannerSchema['summary']) || [],
    data: (raw.data as PlannerSchema['data']) || [],
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

function parseColumn(raw: Record<string, unknown>): ColumnDef {
  return {
    id: raw.id as string,
    label: (raw.label as string) || (raw.id as string),
    type: (raw.type as ColumnDef['type']) || 'text',
    width: raw.width as number | undefined,
    frozen: (raw.frozen as boolean) || false,
    group: raw.group as string | undefined,
    options: raw.options as string[] | undefined,
    min: raw.min as number | undefined,
    max: raw.max as number | undefined,
    formula: raw.formula as string | undefined,
    format: raw.format as string | undefined,
    color_scale: raw.color_scale as Record<number, string> | undefined,
    highlight_if: raw.highlight_if as string | undefined,
  };
}
