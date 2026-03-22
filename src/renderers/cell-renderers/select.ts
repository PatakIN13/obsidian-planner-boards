import { ColumnDef } from '../../types';

export function renderSelect(
  value: string,
  col: ColumnDef,
  onChange: (newVal: string) => void
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-select';

  const display = document.createElement('span');
  display.className = 'planner-cell-display';
  display.textContent = value || '';
  cell.appendChild(display);

  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let tapCount = 0;

  const startEdit = () => {
    if (cell.querySelector('select')) return;
    const select = document.createElement('select');
    select.className = 'planner-cell-input';

    for (const opt of (col.options || [])) {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === value) option.selected = true;
      select.appendChild(option);
    }

    display.classList.add('is-hidden');
    cell.appendChild(select);
    select.focus();

    const commit = () => {
      const newVal = select.value;
      display.textContent = newVal;
      display.classList.remove('is-hidden');
      select.remove();
      if (newVal !== value) {
        onChange(newVal);
      }
    };

    select.addEventListener('change', commit);
    select.addEventListener('blur', commit);
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { display.classList.remove('is-hidden'); select.remove(); }
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
