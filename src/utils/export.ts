import { PlannerSchema, ColumnDef, FormulaContext } from '../types';
import { evaluateFormula } from '../engine/formulas';

/**
 * Export planner data to CSV string.
 */
export function exportToCSV(schema: PlannerSchema): string {
  const lines: string[] = [];

  // Header
  lines.push(schema.columns.map(c => csvEscape(c.label)).join(','));

  // Data rows
  for (const row of schema.data) {
    const cells: string[] = [];
    for (const col of schema.columns) {
      let val = row[col.id];
      if (col.type === 'formula' || (col.type === 'progress' && col.formula)) {
        const ctx: FormulaContext = { row, allRows: schema.data, columns: schema.columns };
        val = col.formula ? evaluateFormula(col.formula, ctx) : val;
      }
      cells.push(csvEscape(formatValue(val)));
    }
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

/**
 * Export planner data to a Markdown table string.
 */
export function exportToMarkdown(schema: PlannerSchema): string {
  const lines: string[] = [];

  // Header
  lines.push('| ' + schema.columns.map(c => c.label).join(' | ') + ' |');

  // Separator
  lines.push('| ' + schema.columns.map(() => '---').join(' | ') + ' |');

  // Data rows
  for (const row of schema.data) {
    const cells: string[] = [];
    for (const col of schema.columns) {
      let val = row[col.id];
      if (col.type === 'formula' || (col.type === 'progress' && col.formula)) {
        const ctx: FormulaContext = { row, allRows: schema.data, columns: schema.columns };
        val = col.formula ? evaluateFormula(col.formula, ctx) : val;
      }
      if (col.type === 'checkbox') {
        val = val ? '✅' : '⬜';
      }
      cells.push(formatValue(val));
    }
    lines.push('| ' + cells.join(' | ') + ' |');
  }

  return lines.join('\n');
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function formatValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}
