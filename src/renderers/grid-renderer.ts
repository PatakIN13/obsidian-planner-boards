import { PlannerSchema, ColumnDef, FormulaContext, SubtableEntry } from '../types';
import { evaluateFormula, evaluateSummaryFormula } from '../engine/formulas';
import { renderCheckbox } from './cell-renderers/checkbox';
import { renderTextInput } from './cell-renderers/text-input';
import { renderNumberInput } from './cell-renderers/number-input';
import { renderSelect } from './cell-renderers/select';
import { renderCombo } from './cell-renderers/combo';
import { renderDateInput } from './cell-renderers/date-input';
import { renderFormulaCell } from './cell-renderers/formula-cell';
import { renderProgressBar } from './cell-renderers/progress-bar';
import { applyConditionalFormatting } from '../engine/conditional-formatting';
import { t } from '../i18n';

export interface GridCallbacks {
  onCellChange: (rowIndex: number, colId: string, newValue: string | number | boolean | null) => void;
  onAddRow?: (afterIndex: number) => void;
  onDeleteRow?: (rowIndex: number) => void;
  onAddColumn?: (afterColId: string, newCol: ColumnDef) => void;
  onDeleteColumn?: (colId: string) => void;
  onMoveRow?: (fromIndex: number, toIndex: number) => void;
  onDuplicateRow?: (rowIndex: number) => void;
  onSchemaFieldChange?: (field: string, value: string | number) => void;
}

export function renderGrid(schema: PlannerSchema, callbacks: GridCallbacks): HTMLElement {
  const container = document.createElement('div');
  container.className = `planner-container planner-theme-${schema.theme || 'soft'}`;

  // Multi-section support (weekly planner etc.)
  const subtables: SubtableEntry[] | undefined = schema._subtables;

  if (subtables && subtables.length > 0) {
    // Title
    if (schema.title) {
      const title = document.createElement('div');
      title.className = 'planner-title';
      title.textContent = schema.title;
      container.appendChild(title);
    }

    // Collect dynamic options for combo columns (refTable -> refColumn)
    const subtableMap = new Map<string, Record<string, string | number | boolean>[]>();
    for (const sub of subtables) {
      subtableMap.set(sub.title, sub.data);
    }
    const resolveComboOptions = (columns: ColumnDef[]) => {
      for (const col of columns) {
        if (col.type === 'combo' && (col.refTable || col.refTables)) {
          const refCol = col.refColumn || 'task';
          const tables: string[] = col.refTables || [col.refTable!];
          const merged: string[] = [];
          for (const tbl of tables) {
            const refData = subtableMap.get(tbl);
            if (refData) {
              for (const r of refData) {
                const v = r[refCol];
                if (v && typeof v === 'string' && !merged.includes(v)) merged.push(v);
              }
            }
          }
          col.options = merged;
        }
      }
    };

    const renderSectionTitle = (sub: typeof subtables extends Array<infer T> ? T : never) => {
      const titleEl = document.createElement('div');
      titleEl.className = 'planner-section-title';
      const titleText = document.createElement('span');
      titleText.textContent = sub.title;
      titleEl.appendChild(titleText);
      if (sub.controls && callbacks.onSchemaFieldChange) {
        for (const ctrl of sub.controls) {
          if (ctrl.type === 'select') {
            const sel = document.createElement('select');
            sel.className = 'planner-section-control';
            for (const opt of ctrl.options) {
              const o = document.createElement('option');
              o.value = String(opt.value);
              o.textContent = opt.label;
              if (String(opt.value) === String(ctrl.value)) o.selected = true;
              sel.appendChild(o);
            }
            sel.addEventListener('change', () => {
              callbacks.onSchemaFieldChange!(ctrl.field, isNaN(Number(sel.value)) ? sel.value : Number(sel.value));
            });
            titleEl.appendChild(sel);
          }
        }
      }
      return titleEl;
    };

    // Create subtable-specific callbacks that operate on the subtable's own data
    const makeSubCallbacks = (subSchema: PlannerSchema): GridCallbacks => ({
      onCellChange: (rowIndex, colId, newValue) => {
        subSchema.data[rowIndex][colId] = newValue;
        // Auto-set completedDate when done checkbox is toggled
        if (colId === 'done' && 'completedDate' in subSchema.data[rowIndex]) {
          if (newValue) {
            // Use planner's day if available, otherwise today
            const plannerDay = schema.day as string | undefined;
            const dateStr = plannerDay || (() => {
              const now = new Date();
              return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            })();
            subSchema.data[rowIndex].completedDate = dateStr;
          } else {
            subSchema.data[rowIndex].completedDate = '';
          }
        }
        // Auto-update _mins when task changes in schedule (multiSelect combo)
        if (colId === 'task' && '_mins' in subSchema.data[rowIndex]) {
          const row = subSchema.data[rowIndex];
          const tasks = (String(newValue || '')).split('|').filter(Boolean);
          const oldMins = (row._mins || '').split('|').filter(Boolean);
          const timeStr = row.time || '06:00';
          const [hh, mm] = timeStr.split(':').map(Number);
          const slotMin = hh * 60 + (mm || 0);
          // Preserve existing _mins for known tasks, assign slot minute for new ones
          const newMins: string[] = [];
          for (let i = 0; i < tasks.length; i++) {
            newMins.push(oldMins[i] || String(slotMin));
          }
          row._mins = newMins.join('|');
        }
        callbacks.onCellChange(-1, '__subtable__', null);
      },
      onAddRow: (afterIndex) => {
        const emptyRow: Record<string, string | number | boolean> = {};
        for (const col of subSchema.columns) {
          switch (col.type) {
            case 'checkbox': emptyRow[col.id] = false; break;
            case 'number': case 'progress': emptyRow[col.id] = 0; break;
            default: emptyRow[col.id] = '';
          }
        }
        subSchema.data.splice(afterIndex + 1, 0, emptyRow);
        callbacks.onCellChange(-1, '__subtable__', null);
      },
      onDeleteRow: (rowIndex) => {
        if (subSchema.data.length <= 1) return;
        subSchema.data.splice(rowIndex, 1);
        callbacks.onCellChange(-1, '__subtable__', null);
      },
      onDuplicateRow: (rowIndex) => {
        const copy = { ...subSchema.data[rowIndex] };
        subSchema.data.splice(rowIndex + 1, 0, copy);
        callbacks.onCellChange(-1, '__subtable__', null);
      },
      onMoveRow: (fromIndex, toIndex) => {
        const [moved] = subSchema.data.splice(fromIndex, 1);
        subSchema.data.splice(toIndex, 0, moved);
        callbacks.onCellChange(-1, '__subtable__', null);
      },
      onSchemaFieldChange: callbacks.onSchemaFieldChange,
    });

    const renderSubSection = (sub: typeof subtables extends Array<infer T> ? T : never, sectionEl: HTMLElement) => {
      resolveComboOptions(sub.columns);

      // Callbacks operate on full data (including empty rows)
      const fullSchema: PlannerSchema = { ...schema, title: '', columns: sub.columns, data: sub.data, summary: [] };
      delete fullSchema._subtables;
      const subCb = makeSubCallbacks(fullSchema);

      // Filter out completely empty rows for display only
      const displayData = sub.data.filter(row => {
        return sub.columns.some(col => {
          if (col.type === 'checkbox') return false;
          const v = row[col.id];
          return v !== '' && v !== undefined && v !== null;
        });
      });

      const titleEl = renderSectionTitle(sub);
      // Add button in header (unless noAddRow is set)
      if (!sub.noAddRow) {
        const addBtn = document.createElement('button');
        addBtn.className = 'planner-section-add-btn';
        // Strip emoji prefix from title for button label
        const cleanTitle = sub.title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, '').trim();
        addBtn.textContent = t('ui.add') + ' ' + cleanTitle.toLowerCase();
        addBtn.addEventListener('click', () => {
          if (sub.onAddItem) {
            sub.onAddItem();
          } else {
            subCb.onAddRow!(sub.data.length - 1);
          }
        });
        titleEl.appendChild(addBtn);
      }
      sectionEl.appendChild(titleEl);

      if (displayData.length > 0) {
        const displaySchema: PlannerSchema = { ...schema, title: '', columns: sub.columns, data: displayData, summary: [] };
        delete displaySchema._subtables;
        sectionEl.appendChild(renderSingleGrid(displaySchema, subCb));
      }
    };

    // Group consecutive subtables with the same group name into flex rows
    // Within a group, items with same groupCol stack vertically in a column
    let i = 0;
    while (i < subtables.length) {
      const sub = subtables[i];
      if (sub.group) {
        const groupName = sub.group;
        const row = document.createElement('div');
        row.className = 'planner-section-row';
        // Collect all items in this group
        const groupItems: typeof subtables = [];
        while (i < subtables.length && subtables[i].group === groupName) {
          groupItems.push(subtables[i]);
          i++;
        }
        // Sub-group by groupCol
        const colGroups = new Map<string, typeof subtables>();
        const colOrder: string[] = [];
        for (const gi of groupItems) {
          const col = gi.groupCol || `_auto_${colOrder.length}`;
          if (!colGroups.has(col)) { colGroups.set(col, []); colOrder.push(col); }
          colGroups.get(col)!.push(gi);
        }
        for (const colName of colOrder) {
          const items = colGroups.get(colName)!;
          if (items.length === 1) {
            const section = document.createElement('div');
            section.className = 'planner-section planner-section-flex';
            renderSubSection(items[0], section);
            row.appendChild(section);
          } else {
            // Stack multiple items vertically in one column
            const colDiv = document.createElement('div');
            colDiv.className = 'planner-section-flex planner-section-col';
            for (const gi of items) {
              const section = document.createElement('div');
              section.className = 'planner-section';
              renderSubSection(gi, section);
              colDiv.appendChild(section);
            }
            row.appendChild(colDiv);
          }
        }
        if (row.childElementCount > 0) container.appendChild(row);
      } else {
        const section = document.createElement('div');
        section.className = 'planner-section';
        renderSubSection(sub, section);
        container.appendChild(section);
        i++;
      }
    }
    return container;
  }

  // Single grid
  if (schema.title) {
    const title = document.createElement('div');
    title.className = 'planner-title';
    title.textContent = schema.title;
    container.appendChild(title);
  }

  container.appendChild(renderSingleGrid(schema, callbacks));
  return container;
}

function renderSingleGrid(schema: PlannerSchema, callbacks: GridCallbacks): HTMLElement {
  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'planner-scroll-wrapper';

  const table = document.createElement('table');
  table.className = 'planner-table';

  // Calculate frozen column offset for sticky positioning
  let frozenOffset = 0;

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  // Drag handle column header
  const dragTh = document.createElement('th');
  dragTh.className = 'planner-th planner-th-drag';
  headerRow.appendChild(dragTh);

  frozenOffset = 0;
  for (const col of schema.columns) {
    const th = document.createElement('th');
    th.className = 'planner-th';
    th.textContent = col.label;
    if (col.width) th.style.setProperty('--col-width', `${col.width}px`);
    if (col.frozen) {
      th.classList.add('planner-frozen');
      th.style.setProperty('--frozen-left', `${24 + frozenOffset}px`); // offset for drag column
      frozenOffset += col.width || 80;
    }

    // Column header context menu (right-click + long-press)
    th.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showColumnContextMenu(e, col, schema, callbacks);
    });

    let colLongPress: ReturnType<typeof setTimeout> | null = null;
    th.addEventListener('touchstart', (e) => {
      colLongPress = setTimeout(() => {
        const touch = e.touches[0];
        const fakeEvent = { pageX: touch.pageX, pageY: touch.pageY, preventDefault: () => {} } as MouseEvent;
        showColumnContextMenu(fakeEvent, col, schema, callbacks);
      }, 500);
    }, { passive: true });
    th.addEventListener('touchend', () => { if (colLongPress) clearTimeout(colLongPress); });
    th.addEventListener('touchmove', () => { if (colLongPress) clearTimeout(colLongPress); });

    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  let dragSourceIndex: number | null = null;
  const VIRTUALIZE_THRESHOLD = 200;
  const useVirtualization = schema.data.length > VIRTUALIZE_THRESHOLD;
  const ROW_HEIGHT = 36; // approximate row height in px

  const renderRow = (row: Record<string, string | number | boolean>, rowIndex: number): HTMLElement => {
    const tr = document.createElement('tr');
    tr.className = 'planner-row';
    tr.dataset.rowIndex = String(rowIndex);

    // Drag handle cell
    const dragTd = document.createElement('td');
    dragTd.className = 'planner-td planner-drag-handle';
    dragTd.textContent = '⠿';
    dragTd.draggable = true;
    dragTd.title = t('ui.dragToMove');

    // Desktop drag & drop
    dragTd.addEventListener('dragstart', (e) => {
      dragSourceIndex = rowIndex;
      tr.classList.add('planner-row-dragging');
      e.dataTransfer?.setData('text/plain', String(rowIndex));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    dragTd.addEventListener('dragend', () => {
      dragSourceIndex = null;
      tr.classList.remove('planner-row-dragging');
      tbody.querySelectorAll('.planner-row-dragover').forEach(el => el.classList.remove('planner-row-dragover'));
    });

    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tr.classList.add('planner-row-dragover');
    });

    tr.addEventListener('dragleave', () => {
      tr.classList.remove('planner-row-dragover');
    });

    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      tr.classList.remove('planner-row-dragover');
      if (dragSourceIndex !== null && dragSourceIndex !== rowIndex) {
        callbacks.onMoveRow?.(dragSourceIndex, rowIndex);
      }
    });

    // Touch drag & drop
    let touchDragActive = false;
    dragTd.addEventListener('touchstart', (e) => {
      touchDragActive = true;
      dragSourceIndex = rowIndex;
      tr.classList.add('planner-row-dragging');
      e.preventDefault();
    }, { passive: false });

    dragTd.addEventListener('touchmove', (e) => {
      if (!touchDragActive) return;
      e.preventDefault();
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = target?.closest('.planner-row') as HTMLElement | null;
      tbody.querySelectorAll('.planner-row-dragover').forEach(el => el.classList.remove('planner-row-dragover'));
      if (targetRow) targetRow.classList.add('planner-row-dragover');
    }, { passive: false });

    dragTd.addEventListener('touchend', (e) => {
      if (!touchDragActive) return;
      touchDragActive = false;
      tr.classList.remove('planner-row-dragging');
      const touch = e.changedTouches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = target?.closest('.planner-row') as HTMLElement | null;
      tbody.querySelectorAll('.planner-row-dragover').forEach(el => el.classList.remove('planner-row-dragover'));
      if (targetRow && dragSourceIndex !== null) {
        const targetIndex = parseInt(targetRow.dataset.rowIndex || '');
        if (!isNaN(targetIndex) && targetIndex !== dragSourceIndex) {
          callbacks.onMoveRow?.(dragSourceIndex, targetIndex);
        }
      }
      dragSourceIndex = null;
    });

    tr.appendChild(dragTd);

    // Row context menu (right-click + long-press)
    tr.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.planner-drag-handle')) return;
      e.preventDefault();
      showContextMenu(e, rowIndex, schema, callbacks);
    });

    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    tr.addEventListener('touchstart', (e) => {
      if ((e.target as HTMLElement).closest('.planner-drag-handle')) return;
      longPressTimer = setTimeout(() => {
        const touch = e.touches[0];
        const fakeEvent = { pageX: touch.pageX, pageY: touch.pageY, preventDefault: () => {} } as MouseEvent;
        showContextMenu(fakeEvent, rowIndex, schema, callbacks);
      }, 500);
    }, { passive: true });
    tr.addEventListener('touchend', () => { if (longPressTimer) clearTimeout(longPressTimer); });
    tr.addEventListener('touchmove', () => { if (longPressTimer) clearTimeout(longPressTimer); });

    frozenOffset = 0;
    for (const col of schema.columns) {
      const td = document.createElement('td');
      td.className = 'planner-td';
      if (col.frozen) {
        td.classList.add('planner-frozen');
        td.style.setProperty('--frozen-left', `${24 + frozenOffset}px`);
        frozenOffset += col.width || 80;
      }
      if (col.width) td.style.setProperty('--col-min-width', `${col.width}px`);

      const cellEl = renderCell(row, col, schema, rowIndex, callbacks);
      td.appendChild(cellEl);

      // Conditional formatting
      applyConditionalFormatting(td, row, col, schema);

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
    return tr;
  };

  if (useVirtualization) {
    // Virtualized rendering: render initial batch, lazy-render rest via IntersectionObserver
    const INITIAL_BATCH = 50;
    for (let i = 0; i < Math.min(INITIAL_BATCH, schema.data.length); i++) {
      renderRow(schema.data[i], i);
    }
    if (schema.data.length > INITIAL_BATCH) {
      // Sentinel placeholder rows
      const remaining: HTMLElement[] = [];
      for (let i = INITIAL_BATCH; i < schema.data.length; i++) {
        const placeholder = document.createElement('tr');
        placeholder.className = 'planner-row planner-row-placeholder';
        placeholder.style.setProperty('--row-height', `${ROW_HEIGHT}px`);
        placeholder.dataset.rowIndex = String(i);
        tbody.appendChild(placeholder);
        remaining.push(placeholder);
      }
      // IntersectionObserver to render on scroll
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const el = entry.target as HTMLElement;
            const idx = parseInt(el.dataset.rowIndex || '0', 10);
            observer.unobserve(el);
            const realRow = renderRow(schema.data[idx], idx);
            el.replaceWith(realRow);
          }
        }
      }, { rootMargin: '200px' });
      for (const ph of remaining) observer.observe(ph);
    }
  } else {
    schema.data.forEach((row, rowIndex) => {
      renderRow(row, rowIndex);
    });
  }

  table.appendChild(tbody);

  // Summary row
  if (schema.summary && schema.summary.length > 0) {
    const tfoot = document.createElement('tfoot');
    const summaryRow = document.createElement('tr');
    summaryRow.className = 'planner-summary-row';

    // Empty cell for drag column
    summaryRow.appendChild(document.createElement('td'));

    for (const col of schema.columns) {
      const td = document.createElement('td');
      td.className = 'planner-td planner-summary-cell';

      const summaryDef = schema.summary.find(s => s.column === col.id);
      if (summaryDef) {
        const val = evaluateSummaryFormula(summaryDef.formula, col.id, schema.data, schema.columns);
        const label = summaryDef.label || '';
        td.textContent = val !== null ? `${label ? label + ': ' : ''}${Math.round(val * 100) / 100}` : '—';
        td.classList.add('planner-summary-value');
      }

      summaryRow.appendChild(td);
    }

    tfoot.appendChild(summaryRow);
    table.appendChild(tfoot);
  }

  scrollWrapper.appendChild(table);
  return scrollWrapper;
}

function renderCell(
  row: Record<string, string | number | boolean>,
  col: ColumnDef,
  schema: PlannerSchema,
  rowIndex: number,
  callbacks: GridCallbacks
): HTMLElement {
  const value = row[col.id];
  const onChange = (newVal: string | number | boolean) => {
    const td = cell.closest<HTMLElement>('.planner-td') ?? null;
    if (td) {
      td.classList.remove('planner-cell-flash');
      void td.offsetWidth; // force reflow
      td.classList.add('planner-cell-flash');
    }
    callbacks.onCellChange(rowIndex, col.id, newVal);
  };

  let cell: HTMLElement;

  switch (col.type) {
    case 'checkbox':
      cell = renderCheckbox(Boolean(value), col, onChange);
      break;
    case 'number':
      cell = renderNumberInput(value, col, onChange);
      break;
    case 'select':
      cell = renderSelect(value || '', col, onChange);
      break;
    case 'combo':
      cell = renderCombo(String(value ?? ''), col, onChange);
      break;
    case 'formula': {
      const ctx: FormulaContext = { row, allRows: schema.data, columns: schema.columns };
      const computed = col.formula ? evaluateFormula(col.formula, ctx) : null;
      cell = renderFormulaCell(computed, col);
      break;
    }
    case 'progress': {
      if (col.formula) {
        const ctx: FormulaContext = { row, allRows: schema.data, columns: schema.columns };
        const computed = evaluateFormula(col.formula, ctx);
        cell = renderProgressBar(computed, col);
      } else {
        cell = renderProgressBar(typeof value === 'number' ? value : null, col);
      }
      break;
    }
    case 'date':
      cell = renderDateInput(String(value ?? ''), col, onChange);
      break;
    case 'text':
    default:
      cell = renderTextInput(String(value ?? ''), col, onChange);
      break;
  }

  // Render obsidian:// URIs as clickable links in text cells
  if ((col.type === 'text' || !col.type) && typeof value === 'string' && value.startsWith('obsidian://')) {
    const link = document.createElement('a');
    link.className = 'planner-cell-link';
    link.href = value;
    link.textContent = decodeURIComponent(value.replace('obsidian://', ''));
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(value);
    });
    cell.querySelector('.planner-cell-display')?.replaceWith(link);
  }

  return cell;
}

function showContextMenu(
  e: MouseEvent,
  rowIndex: number,
  schema: PlannerSchema,
  callbacks: GridCallbacks
) {
  // Remove any existing context menu
  document.querySelectorAll('.planner-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'planner-context-menu';
  menu.style.setProperty('--menu-left', `${e.pageX}px`);
  menu.style.setProperty('--menu-top', `${e.pageY}px`);

  const items = [
    { label: t('ctx.addRowAbove'), action: () => callbacks.onAddRow?.(rowIndex - 1) },
    { label: t('ctx.addRowBelow'), action: () => callbacks.onAddRow?.(rowIndex) },
    { label: t('ctx.duplicateRow'), action: () => callbacks.onDuplicateRow?.(rowIndex) },
    { label: t('ctx.deleteRow'), action: () => callbacks.onDeleteRow?.(rowIndex) },
  ];

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'planner-context-menu-item';
    div.textContent = item.label;
    div.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(div);
  }

  document.body.appendChild(menu);

  const close = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showColumnContextMenu(
  e: MouseEvent,
  col: ColumnDef,
  schema: PlannerSchema,
  callbacks: GridCallbacks
) {
  document.querySelectorAll('.planner-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'planner-context-menu';
  menu.style.setProperty('--menu-left', `${e.pageX}px`);
  menu.style.setProperty('--menu-top', `${e.pageY}px`);

  const items = [
    {
      label: t('ctx.addColumnRight'),
      action: () => {
        const newCol: ColumnDef = {
          id: `col_${Date.now()}`,
          label: t('ctx.newColumnLabel'),
          type: 'text',
        };
        callbacks.onAddColumn?.(col.id, newCol);
      },
    },
    {
      label: t('ctx.deleteColumn'),
      action: () => {
        if (schema.columns.length <= 1) return;
        callbacks.onDeleteColumn?.(col.id);
      },
    },
    { label: t('ctx.sortAsc'), action: () => sortColumn(schema, col.id, 'asc', callbacks) },
    { label: t('ctx.sortDesc'), action: () => sortColumn(schema, col.id, 'desc', callbacks) },
  ];

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'planner-context-menu-item';
    div.textContent = item.label;
    div.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(div);
  }

  document.body.appendChild(menu);

  const close = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function sortColumn(
  schema: PlannerSchema,
  colId: string,
  direction: 'asc' | 'desc',
  callbacks: GridCallbacks
) {
  // Sort data in place then trigger a full re-render via a cell change on first row
  schema.data.sort((a, b) => {
    const va = a[colId];
    const vb = b[colId];
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb));
    return direction === 'asc' ? cmp : -cmp;
  });
  // Trigger re-render by "changing" first cell to its own value
  if (schema.data.length > 0) {
    callbacks.onCellChange(0, colId, schema.data[0][colId]);
  }
}
