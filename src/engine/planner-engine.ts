import { PlannerSchema } from '../types';
import { parseSchema } from '../parser/schema-parser';
import { serializeSchema } from '../parser/data-serializer';
import { renderGrid } from '../renderers/grid-renderer';
import { expandTemplate } from '../templates/template-registry';
import { validateCellValue } from './validators';

export interface PlannerEngineCallbacks {
  onDataChange: (newYaml: string) => void;
  suppressTitle?: boolean;
  onAddItem?: (subtableTitle: string) => void;
}

const MAX_UNDO = 50;

/**
 * Main planner engine: parses YAML, renders grid, handles data changes.
 * Supports Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z / Ctrl+Y).
 */
export function createPlanner(
  source: string,
  containerEl: HTMLElement,
  callbacks: PlannerEngineCallbacks
): void {
  let schema: PlannerSchema;

  try {
    schema = parseSchema(source);
  } catch (e) {
    const errorEl = document.createElement('div');
    errorEl.className = 'planner-error';
    errorEl.textContent = `⚠️ Planner error: ${e instanceof Error ? e.message : 'Invalid YAML'}`;
    containerEl.appendChild(errorEl);
    return;
  }

  if (schema.template) {
    try {
      schema = expandTemplate(schema);
    } catch (e) {
      const errorEl = document.createElement('div');
      errorEl.className = 'planner-error';
      errorEl.textContent = `⚠️ Template error: ${e instanceof Error ? e.message : 'Unknown template'}`;
      containerEl.appendChild(errorEl);
      return;
    }
  }

  if (callbacks.suppressTitle) {
    schema.title = '';
  }

  // Wire up onAddItem callbacks for subtables
  if (callbacks.onAddItem && schema._subtables) {
    for (const sub of schema._subtables) {
      sub.onAddItem = () => callbacks.onAddItem!(sub.title);
    }
  }

  let currentSource = source;

  // Undo/Redo history
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  const pushUndo = () => {
    const snap = serializeSchema(schema);
    undoStack.push(snap);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  };

  const rerender = () => {
    const newYaml = serializeSchema(schema);
    document.removeEventListener('keydown', onKeyDown);
    containerEl.empty();
    createPlanner(newYaml, containerEl, callbacks);
    if (newYaml !== currentSource) {
      callbacks.onDataChange(newYaml);
    }
  };

  // Keyboard listener for Undo/Redo
  const onKeyDown = (e: KeyboardEvent) => {
    if (!containerEl.isConnected) {
      document.removeEventListener('keydown', onKeyDown);
      return;
    }
    // Only handle if this planner's container is focused or contains focus
    if (!containerEl.contains(document.activeElement) && document.activeElement !== containerEl) return;

    const isMod = e.ctrlKey || e.metaKey;
    if (isMod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undoStack.length === 0) return;
      redoStack.push(serializeSchema(schema));
      const prev = undoStack.pop()!;
      containerEl.empty();
      createPlanner(prev, containerEl, callbacks);
      callbacks.onDataChange(prev);
    } else if (isMod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault();
      if (redoStack.length === 0) return;
      undoStack.push(serializeSchema(schema));
      const next = redoStack.pop()!;
      containerEl.empty();
      createPlanner(next, containerEl, callbacks);
      callbacks.onDataChange(next);
    }
  };
  document.addEventListener('keydown', onKeyDown);

  // Make container focusable for keyboard events
  if (!containerEl.getAttribute('tabindex')) {
    containerEl.setAttribute('tabindex', '-1');
  }

  const gridEl = renderGrid(schema, {
    onCellChange: (rowIndex, colId, newValue) => {
      // Subtable changes: data already modified by the subtable callback
      if (colId === '__subtable__') {
        pushUndo();
        rerender();
        return;
      }
      const col = schema.columns.find(c => c.id === colId);
      if (!col) return;
      pushUndo();
      const { coerced } = validateCellValue(newValue, col);
      schema.data[rowIndex][colId] = coerced;
      rerender();
    },
    onAddRow: (afterIndex) => {
      pushUndo();
      const emptyRow: Record<string, string | number | boolean> = {};
      for (const col of schema.columns) {
        switch (col.type) {
          case 'checkbox': emptyRow[col.id] = false; break;
          case 'number': case 'progress': emptyRow[col.id] = 0; break;
          default: emptyRow[col.id] = '';
        }
      }
      schema.data.splice(afterIndex + 1, 0, emptyRow);
      rerender();
    },
    onDeleteRow: (rowIndex) => {
      if (schema.data.length <= 1) return;
      pushUndo();
      schema.data.splice(rowIndex, 1);
      rerender();
    },
    onMoveRow: (fromIndex, toIndex) => {
      pushUndo();
      const [moved] = schema.data.splice(fromIndex, 1);
      schema.data.splice(toIndex, 0, moved);
      rerender();
    },
    onDuplicateRow: (rowIndex) => {
      pushUndo();
      const copy = { ...schema.data[rowIndex] };
      schema.data.splice(rowIndex + 1, 0, copy);
      rerender();
    },
    onAddColumn: (afterColId, newCol) => {
      const idx = schema.columns.findIndex(c => c.id === afterColId);
      if (idx === -1) return;
      pushUndo();
      schema.columns.splice(idx + 1, 0, newCol);
      for (const row of schema.data) {
        row[newCol.id] = newCol.type === 'checkbox' ? false : '';
      }
      rerender();
    },
    onDeleteColumn: (colId) => {
      if (schema.columns.length <= 1) return;
      pushUndo();
      schema.columns = schema.columns.filter(c => c.id !== colId);
      for (const row of schema.data) {
        delete row[colId];
      }
      rerender();
    },
    onSchemaFieldChange: (field, value) => {
      pushUndo();
      schema[field] = value;
      // When timeInterval changes, preserve assigned tasks and re-map to new slots
      // Tasks are stored pipe-separated in `task`, with original minutes in `_mins`
      if (field === 'timeInterval' && schema.sections) {
        const scheduleData = schema.sections['schedule'] || [];
        const oldSchedule = scheduleData as Array<{ time: string; task: string; _mins?: string }>;
        const interval = Number(value) || 60;

        const timeToMinutes = (t: string) => {
          const [hh, mm] = t.split(':').map(Number);
          return hh * 60 + (mm || 0);
        };
        const minutesToTime = (m: number) => {
          const h = Math.floor(m / 60);
          const min = m % 60;
          return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        };

        // Extract all individual (originalMinutes, taskName) pairs
        const allTasks: { min: number; task: string }[] = [];
        for (const row of oldSchedule) {
          const tasks = (row.task || '').split('|').map(s => s.trim()).filter(Boolean);
          const mins = (row._mins || '').split('|').map(s => s.trim()).filter(Boolean);
          const slotMin = timeToMinutes(row.time);
          for (let j = 0; j < tasks.length; j++) {
            const origMin = mins[j] ? parseInt(mins[j], 10) : slotMin;
            allTasks.push({ min: origMin, task: tasks[j] });
          }
        }

        // Generate new time slots
        const newSlots: string[] = [];
        for (let m = 360; m <= 1320; m += interval) {
          newSlots.push(minutesToTime(m));
        }
        const newSchedule: { time: string; task: string; _mins: string }[] =
          newSlots.map(t => ({ time: t, task: '', _mins: '' }));

        // Place each task at nearest new slot
        const findNearest = (minutes: number): number => {
          let best = 0;
          let bestDiff = Infinity;
          for (let i = 0; i < newSchedule.length; i++) {
            const diff = Math.abs(timeToMinutes(newSchedule[i].time) - minutes);
            if (diff < bestDiff) { bestDiff = diff; best = i; }
          }
          return best;
        };
        // Sort by original minute to preserve order
        allTasks.sort((a, b) => a.min - b.min);
        for (const a of allTasks) {
          const idx = findNearest(a.min);
          const existing = newSchedule[idx].task ? newSchedule[idx].task.split('|') : [];
          const existingMins = newSchedule[idx]._mins ? newSchedule[idx]._mins.split('|') : [];
          existing.push(a.task);
          existingMins.push(String(a.min));
          newSchedule[idx].task = existing.join('|');
          newSchedule[idx]._mins = existingMins.join('|');
        }

        schema.sections['schedule'] = newSchedule as unknown as Array<Record<string, string | number | boolean>>;
      }
      rerender();
    },
  });

  containerEl.appendChild(gridEl);
}
