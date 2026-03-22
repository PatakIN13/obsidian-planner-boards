import { ColumnDef, PlannerSchema } from '../types';

/**
 * Apply conditional formatting to a cell element based on column rules.
 */
export function applyConditionalFormatting(
  td: HTMLElement,
  row: Record<string, any>,
  col: ColumnDef,
  schema: PlannerSchema
): void {
  const value = row[col.id];

  // color_scale: gradient coloring by numeric value
  if (col.color_scale && typeof value === 'number') {
    const color = getScaleColor(value, col.color_scale);
    if (color) {
      td.style.backgroundColor = color + '20'; // 12% opacity
      td.style.borderLeft = `3px solid ${color}`;
    }
  }

  // highlight_if: e.g. "> 100", "< 0", "== done"
  if (col.highlight_if) {
    const shouldHighlight = evaluateCondition(value, col.highlight_if);
    if (shouldHighlight) {
      td.classList.add('planner-highlight');
    }
  }
}

function evaluateCondition(value: any, condition: string): boolean {
  const match = condition.match(/^(>=?|<=?|==|!=)\s*(.+)$/);
  if (!match) return false;

  const [, op, rawTarget] = match;
  let target: any = rawTarget.trim();

  // Parse target
  if (target === 'true') target = true;
  else if (target === 'false') target = false;
  else if (!isNaN(Number(target))) target = Number(target);
  else if (target.startsWith('"') && target.endsWith('"')) target = target.slice(1, -1);

  const numVal = typeof value === 'number' ? value : Number(value);
  const isNumeric = !isNaN(numVal) && typeof target === 'number';

  switch (op) {
    case '>': return isNumeric && numVal > target;
    case '>=': return isNumeric && numVal >= target;
    case '<': return isNumeric && numVal < target;
    case '<=': return isNumeric && numVal <= target;
    case '==': return value == target;
    case '!=': return value != target;
    default: return false;
  }
}

function getScaleColor(value: number, scale: Record<number, string>): string {
  const thresholds = Object.keys(scale).map(Number).sort((a, b) => a - b);
  if (thresholds.length === 0) return '';
  if (value <= thresholds[0]) return scale[thresholds[0]];
  if (value >= thresholds[thresholds.length - 1]) return scale[thresholds[thresholds.length - 1]];
  for (let i = 0; i < thresholds.length - 1; i++) {
    if (value >= thresholds[i] && value <= thresholds[i + 1]) {
      return scale[thresholds[i + 1]];
    }
  }
  return scale[thresholds[thresholds.length - 1]];
}
