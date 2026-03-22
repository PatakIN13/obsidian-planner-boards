import { ColumnDef } from '../types';

function unknownToString(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return String(val as string);
}

export function validateCellValue(value: unknown, column: ColumnDef): { valid: boolean; coerced: string | number | boolean } {
  switch (column.type) {
    case 'checkbox':
      return { valid: true, coerced: Boolean(value) };

    case 'number':
    case 'progress': {
      const n = typeof value === 'number' ? value : parseFloat(unknownToString(value));
      if (isNaN(n)) return { valid: false, coerced: 0 };
      let clamped = n;
      if (column.min !== undefined) clamped = Math.max(column.min, clamped);
      if (column.max !== undefined) clamped = Math.min(column.max, clamped);
      return { valid: true, coerced: clamped };
    }

    case 'select':
      if (column.options && !column.options.includes(unknownToString(value))) {
        return { valid: false, coerced: unknownToString(value) };
      }
      return { valid: true, coerced: unknownToString(value) };

    case 'text':
      return { valid: true, coerced: unknownToString(value) };

    case 'date':
      return { valid: true, coerced: unknownToString(value) };

    case 'formula':
      // Formula cells are read-only
      if (typeof value === 'number') return { valid: false, coerced: value };
      if (typeof value === 'boolean') return { valid: false, coerced: value };
      return { valid: false, coerced: unknownToString(value) };

    default:
      if (typeof value === 'number') return { valid: true, coerced: value };
      if (typeof value === 'boolean') return { valid: true, coerced: value };
      return { valid: true, coerced: unknownToString(value) };
  }
}
