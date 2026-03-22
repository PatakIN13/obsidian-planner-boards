import { describe, it, expect } from 'vitest';
import { applyConditionalFormatting } from '../../src/engine/conditional-formatting';
import { ColumnDef, PlannerSchema } from '../../src/types';

// Minimal HTMLElement mock
function mockElement(): HTMLElement {
  const styles: Record<string, string> = {};
  const classes = new Set<string>();
  return {
    style: {
      setProperty(name: string, value: string) { styles[name] = value; },
    },
    classList: {
      add(cls: string) { classes.add(cls); },
      contains(cls: string) { return classes.has(cls); },
    },
    _styles: styles,
    _classes: classes,
  } as unknown as HTMLElement;
}

function makeSchema(cols: ColumnDef[]): PlannerSchema {
  return { columns: cols, data: [] };
}

describe('applyConditionalFormatting — highlight_if', () => {
  it('adds highlight class when condition "> 100" matches', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number', highlight_if: '> 100' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: 150 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('does not highlight when condition not met', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number', highlight_if: '> 100' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: 50 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(false);
  });

  it('handles >= condition', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number', highlight_if: '>= 10' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: 10 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('handles < condition', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number', highlight_if: '< 0' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: -5 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('handles <= condition', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number', highlight_if: '<= 5' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: 5 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('handles == condition with string', () => {
    const col: ColumnDef = { id: 'status', label: 'Status', type: 'text', highlight_if: '== "done"' };
    const td = mockElement();
    applyConditionalFormatting(td, { status: 'done' }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('handles != condition', () => {
    const col: ColumnDef = { id: 'status', label: 'Status', type: 'text', highlight_if: '!= "done"' };
    const td = mockElement();
    applyConditionalFormatting(td, { status: 'pending' }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });

  it('handles == true for boolean', () => {
    const col: ColumnDef = { id: 'done', label: 'Done', type: 'checkbox', highlight_if: '== true' };
    const td = mockElement();
    applyConditionalFormatting(td, { done: true }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-highlight')).toBe(true);
  });
});

describe('applyConditionalFormatting — color_scale', () => {
  it('applies color scale CSS properties for numeric values', () => {
    const col: ColumnDef = {
      id: 'score', label: 'Score', type: 'number',
      color_scale: { 0: '#ff0000', 50: '#ffff00', 100: '#00ff00' },
    };
    const td = mockElement();
    applyConditionalFormatting(td, { score: 75 }, col, makeSchema([col]));
    const styles = (td as unknown as { _styles: Record<string, string> })._styles;
    expect(styles['--cond-bg']).toBeDefined();
    expect(styles['--cond-border-color']).toBeDefined();
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-cond-scaled')).toBe(true);
  });

  it('handles value at lowest threshold', () => {
    const col: ColumnDef = {
      id: 'score', label: 'Score', type: 'number',
      color_scale: { 0: '#ff0000', 100: '#00ff00' },
    };
    const td = mockElement();
    applyConditionalFormatting(td, { score: 0 }, col, makeSchema([col]));
    const styles = (td as unknown as { _styles: Record<string, string> })._styles;
    expect(styles['--cond-border-color']).toBe('#ff0000');
  });

  it('handles value above highest threshold', () => {
    const col: ColumnDef = {
      id: 'score', label: 'Score', type: 'number',
      color_scale: { 0: '#ff0000', 100: '#00ff00' },
    };
    const td = mockElement();
    applyConditionalFormatting(td, { score: 200 }, col, makeSchema([col]));
    const styles = (td as unknown as { _styles: Record<string, string> })._styles;
    expect(styles['--cond-border-color']).toBe('#00ff00');
  });

  it('does not apply color_scale for non-numeric values', () => {
    const col: ColumnDef = {
      id: 'score', label: 'Score', type: 'number',
      color_scale: { 0: '#ff0000', 100: '#00ff00' },
    };
    const td = mockElement();
    applyConditionalFormatting(td, { score: 'abc' }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.has('planner-cond-scaled')).toBe(false);
  });
});

describe('applyConditionalFormatting — no conditions', () => {
  it('does nothing when no highlight_if or color_scale', () => {
    const col: ColumnDef = { id: 'val', label: 'Val', type: 'number' };
    const td = mockElement();
    applyConditionalFormatting(td, { val: 42 }, col, makeSchema([col]));
    expect((td as unknown as { _classes: Set<string> })._classes.size).toBe(0);
  });
});
