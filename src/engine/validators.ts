import { ColumnDef } from '../types';

export function validateCellValue(value: any, column: ColumnDef): { valid: boolean; coerced: any } {
  switch (column.type) {
    case 'checkbox':
      return { valid: true, coerced: Boolean(value) };

    case 'number':
    case 'progress': {
      const n = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(n)) return { valid: false, coerced: 0 };
      let clamped = n;
      if (column.min !== undefined) clamped = Math.max(column.min, clamped);
      if (column.max !== undefined) clamped = Math.min(column.max, clamped);
      return { valid: true, coerced: clamped };
    }

    case 'select':
      if (column.options && !column.options.includes(String(value))) {
        return { valid: false, coerced: value };
      }
      return { valid: true, coerced: String(value) };

    case 'text':
      return { valid: true, coerced: String(value ?? '') };

    case 'date':
      return { valid: true, coerced: String(value ?? '') };

    case 'formula':
      // Formula cells are read-only
      return { valid: false, coerced: value };

    default:
      return { valid: true, coerced: value };
  }
}
