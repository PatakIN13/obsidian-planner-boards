import { ColumnDef } from '../../types';

/**
 * Combo cell renderer with three modes:
 * - multiSelect: show tasks as tags with "+" to add more (pipe-separated storage)
 * - selectOnly: pure <select> dropdown, no free text
 * - default: datalist-backed input (suggestions + free text)
 */
export function renderCombo(
  value: string,
  col: ColumnDef,
  onChange: (newVal: string) => void
): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'planner-cell planner-cell-combo';

  // ── Multi-select mode: tags + "+" button ──
  if (col.multiSelect) {
    cell.classList.add('planner-cell-multiselect');
    const tasks = (value || '').split('|').map(s => s.trim()).filter(Boolean);
    const available = (col.options || []).filter(o => o && !tasks.includes(o));

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'planner-multi-tags';

    const rebuild = () => {
      while (tagsWrap.firstChild) tagsWrap.removeChild(tagsWrap.firstChild);
      const curTasks = (value || '').split('|').map(s => s.trim()).filter(Boolean);
      for (const t of curTasks) {
        const tag = document.createElement('span');
        tag.className = 'planner-multi-tag';
        tag.textContent = t;
        const rm = document.createElement('span');
        rm.className = 'planner-multi-tag-rm';
        rm.textContent = '×';
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          const updated = curTasks.filter(x => x !== t);
          value = updated.join('|');
          onChange(value);
          rebuild();
        });
        tag.appendChild(rm);
        tagsWrap.appendChild(tag);
      }
    };
    rebuild();
    cell.appendChild(tagsWrap);

    // Open dropdown to pick a task
    const openDropdown = () => {
      if (cell.querySelector('.planner-multi-dropdown')) return;
      const curTasks = (value || '').split('|').map(s => s.trim()).filter(Boolean);
      const avail = (col.options || []).filter(o => o && !curTasks.includes(o));
      if (avail.length === 0) return;

      const sel = document.createElement('select');
      sel.className = 'planner-cell-input planner-multi-dropdown';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '—';
      sel.appendChild(emptyOpt);
      for (const opt of avail) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
      }
      cell.appendChild(sel);
      sel.focus();

      const commit = () => {
        if (sel.value) {
          const updated = [...curTasks, sel.value];
          value = updated.join('|');
          onChange(value);
          rebuild();
        }
        sel.remove();
      };
      sel.addEventListener('change', commit);
      sel.addEventListener('blur', () => sel.remove());
    };

    // Click on cell or tags area does nothing — only "+" opens dropdown
    // "+" button
    const addBtn = document.createElement('button');
    addBtn.className = 'planner-schedule-add-btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDropdown();
    });
    cell.appendChild(addBtn);
    return cell;
  }

  // ── Select-only mode ──
  if (col.selectOnly) {
    const display = document.createElement('span');
    display.className = 'planner-cell-display';
    display.textContent = value || '';
    cell.appendChild(display);

    const startEdit = () => {
      if (cell.querySelector('select')) return;
      const sel = document.createElement('select');
      sel.className = 'planner-cell-input planner-cell-select';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '—';
      sel.appendChild(emptyOpt);
      for (const opt of (col.options || [])) {
        if (!opt) continue;
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === value) o.selected = true;
        sel.appendChild(o);
      }
      if (!value) emptyOpt.selected = true;
      display.classList.add('is-hidden');
      cell.appendChild(sel);
      sel.focus();

      const commit = () => {
        const newVal = sel.value;
        display.textContent = newVal;
        display.classList.remove('is-hidden');
        sel.remove();
        if (newVal !== value) onChange(newVal);
      };
      sel.addEventListener('blur', commit);
      sel.addEventListener('change', commit);
      sel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { display.classList.remove('is-hidden'); sel.remove(); }
      });
    };

    cell.addEventListener('dblclick', startEdit);
    cell.addEventListener('touchend', (() => {
      let tapCount = 0;
      let tapTimer: ReturnType<typeof setTimeout> | null = null;
      return (e: TouchEvent) => {
        tapCount++;
        if (tapCount === 1) {
          tapTimer = setTimeout(() => { tapCount = 0; }, 300);
        } else if (tapCount === 2) {
          if (tapTimer) clearTimeout(tapTimer);
          tapCount = 0;
          e.preventDefault();
          startEdit();
        }
      };
    })());

    return cell;
  }

  // ── Default combo mode with datalist ──
  const display = document.createElement('span');
  display.className = 'planner-cell-display';
  display.textContent = value || '';
  cell.appendChild(display);

  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let tapCount = 0;

  const startEdit = () => {
    if (cell.querySelector('input')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'planner-combo-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'planner-cell-input';
    input.value = value || '';
    input.placeholder = col.options?.length ? '↓' : '';

    const listId = `combo-${col.id}-${Date.now()}`;
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    for (const opt of (col.options || [])) {
      if (!opt) continue;
      const option = document.createElement('option');
      option.value = opt;
      datalist.appendChild(option);
    }
    input.setAttribute('list', listId);

    wrapper.appendChild(input);
    wrapper.appendChild(datalist);

    display.classList.add('is-hidden');
    cell.appendChild(wrapper);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value;
      display.textContent = newVal;
      display.classList.remove('is-hidden');
      wrapper.remove();
      if (newVal !== value) {
        onChange(newVal);
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { display.classList.remove('is-hidden'); wrapper.remove(); }
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
