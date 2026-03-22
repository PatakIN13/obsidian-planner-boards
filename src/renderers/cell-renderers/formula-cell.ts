import { ColumnDef } from '../../types';

export function renderFormulaCell(
  value: number | null,
  col: ColumnDef
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-formula';

  if (value === null) {
    cell.textContent = '—';
    return cell;
  }

  let displayText = String(value);
  if (col.format) {
    displayText = col.format.replace('{value}', String(value));
  }

  // Check if this is a progress-type formula
  if (col.type === 'progress') {
    const min = col.min ?? 0;
    const max = col.max ?? 100;
    const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

    const bar = document.createElement('div');
    bar.className = 'planner-progress-bar';

    const fill = document.createElement('div');
    fill.className = 'planner-progress-fill';
    fill.style.width = `${percent}%`;

    // Apply color scale
    if (col.color_scale) {
      fill.style.backgroundColor = getScaleColor(value, col.color_scale);
    }

    const label = document.createElement('span');
    label.className = 'planner-progress-label';
    label.textContent = `${Math.round(percent)}%`;

    bar.appendChild(fill);
    cell.appendChild(bar);
    cell.appendChild(label);
    return cell;
  }

  // Apply color scale for non-progress formulas
  if (col.color_scale) {
    cell.style.color = getScaleColor(value, col.color_scale);
    cell.style.fontWeight = 'bold';
  }

  cell.textContent = displayText;
  return cell;
}

function getScaleColor(value: number, scale: Record<number, string>): string {
  const thresholds = Object.keys(scale).map(Number).sort((a, b) => a - b);
  if (thresholds.length === 0) return '';

  if (value <= thresholds[0]) return scale[thresholds[0]];
  if (value >= thresholds[thresholds.length - 1]) return scale[thresholds[thresholds.length - 1]];

  // Interpolate between two closest thresholds
  for (let i = 0; i < thresholds.length - 1; i++) {
    if (value >= thresholds[i] && value <= thresholds[i + 1]) {
      return scale[thresholds[i + 1]];
    }
  }

  return scale[thresholds[thresholds.length - 1]];
}
