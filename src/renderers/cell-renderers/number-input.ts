import { ColumnDef } from '../../types';

export function renderNumberInput(
  value: number | undefined,
  col: ColumnDef,
  onChange: (newVal: number) => void
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-number';

  const display = document.createElement('span');
  display.className = 'planner-cell-display';
  display.textContent = value !== undefined && value !== null ? String(value) : '';
  cell.appendChild(display);

  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let tapCount = 0;

  const startEdit = () => {
    if (cell.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'planner-cell-input';
    input.value = value !== undefined && value !== null ? String(value) : '';
    if (col.min !== undefined) input.min = String(col.min);
    if (col.max !== undefined) input.max = String(col.max);
    display.style.display = 'none';
    cell.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      let newVal = parseFloat(input.value);
      if (isNaN(newVal)) newVal = 0;
      if (col.min !== undefined) newVal = Math.max(col.min, newVal);
      if (col.max !== undefined) newVal = Math.min(col.max, newVal);
      display.textContent = String(newVal);
      display.style.display = '';
      input.remove();
      if (newVal !== value) {
        onChange(newVal);
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { display.style.display = ''; input.remove(); }
    });
  };

  cell.addEventListener('dblclick', startEdit);
  cell.addEventListener('touchend', (e) => {
    tapCount++;
    if (tapCount === 1) {
      tapTimer = setTimeout(() => { tapCount = 0; }, 300);
    } else if (tapCount === 2) {
      if (tapTimer) clearTimeout(tapTimer);
      tapCount = 0;
      e.preventDefault();
      startEdit();
    }
  });

  return cell;
}
