import { ColumnDef } from '../../types';

export function renderCheckbox(
  value: boolean,
  col: ColumnDef,
  onChange: (newVal: boolean) => void
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-checkbox';

  const display = document.createElement('span');
  display.className = 'planner-checkbox';
  display.textContent = value ? '✅' : '⬜';
  display.setAttribute('role', 'checkbox');
  display.setAttribute('aria-checked', String(value));
  display.tabIndex = 0;

  display.addEventListener('click', (e) => {
    e.stopPropagation();
    const newVal = !value;
    display.textContent = newVal ? '✅' : '⬜';
    display.setAttribute('aria-checked', String(newVal));
    onChange(newVal);
  });

  display.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      display.click();
    }
  });

  cell.appendChild(display);
  return cell;
}
