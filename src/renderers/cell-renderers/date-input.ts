import { ColumnDef } from '../../types';

export function renderDateInput(
  value: string,
  col: ColumnDef,
  onChange: (newVal: string) => void
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-date';

  const display = document.createElement('span');
  display.className = 'planner-cell-display';
  display.textContent = value || '';
  cell.appendChild(display);

  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let tapCount = 0;

  const startEdit = () => {
    if (cell.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'planner-cell-input';
    input.value = value || '';
    display.classList.add('is-hidden');
    cell.appendChild(input);
    input.focus();

    const commit = () => {
      const newVal = input.value;
      display.textContent = newVal;
      display.classList.remove('is-hidden');
      input.remove();
      if (newVal !== value) {
        onChange(newVal);
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { display.classList.remove('is-hidden'); input.remove(); }
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
