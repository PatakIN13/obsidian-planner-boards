import { ColumnDef } from '../../types';

export function renderProgressBar(
  value: number | null,
  col: ColumnDef
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-progress';

  const min = col.min ?? 0;
  const max = col.max ?? 100;
  const numValue = value ?? 0;
  const percent = Math.max(0, Math.min(100, ((numValue - min) / (max - min)) * 100));

  const bar = document.createElement('div');
  bar.className = 'planner-progress-bar';

  const fill = document.createElement('div');
  fill.className = 'planner-progress-fill';
  fill.style.width = `${percent}%`;

  if (col.color_scale) {
    fill.style.backgroundColor = getScaleColor(numValue, col.color_scale);
  }

  const label = document.createElement('span');
  label.className = 'planner-progress-label';
  label.textContent = `${Math.round(percent)}%`;

  bar.appendChild(fill);
  cell.appendChild(bar);
  cell.appendChild(label);
  return cell;
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
