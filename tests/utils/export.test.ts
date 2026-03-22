import { describe, it, expect } from 'vitest';
import { exportToCSV, exportToMarkdown } from '../../src/utils/export';
import { PlannerSchema, ColumnDef } from '../../src/types';

function makeSchema(
  columns: ColumnDef[],
  data: Record<string, string | number | boolean>[],
): PlannerSchema {
  return { columns, data };
}

const cols: ColumnDef[] = [
  { id: 'name', label: 'Name', type: 'text' },
  { id: 'score', label: 'Score', type: 'number' },
  { id: 'done', label: 'Done', type: 'checkbox' },
];

const rows = [
  { name: 'Alice', score: 90, done: true },
  { name: 'Bob', score: 85, done: false },
];

describe('exportToCSV', () => {
  it('generates header row', () => {
    const csv = exportToCSV(makeSchema(cols, rows));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Name,Score,Done');
  });

  it('generates data rows', () => {
    const csv = exportToCSV(makeSchema(cols, rows));
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 data
    expect(lines[1]).toBe('Alice,90,true');
    expect(lines[2]).toBe('Bob,85,false');
  });

  it('handles empty data', () => {
    const csv = exportToCSV(makeSchema(cols, []));
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1); // header only
  });

  it('escapes commas in values', () => {
    const csv = exportToCSV(makeSchema(
      [{ id: 'note', label: 'Note', type: 'text' }],
      [{ note: 'hello, world' }],
    ));
    expect(csv).toContain('"hello, world"');
  });

  it('escapes double quotes in values', () => {
    const csv = exportToCSV(makeSchema(
      [{ id: 'note', label: 'Note', type: 'text' }],
      [{ note: 'say "hi"' }],
    ));
    expect(csv).toContain('"say ""hi"""');
  });

  it('handles null/undefined values', () => {
    const csv = exportToCSV(makeSchema(
      [{ id: 'a', label: 'A', type: 'text' }],
      [{ a: undefined as unknown as string }],
    ));
    const lines = csv.split('\n');
    expect(lines[1]).toBe('');
  });

  it('evaluates formula columns', () => {
    const formulaCols: ColumnDef[] = [
      { id: 'a', label: 'A', type: 'number' },
      { id: 'b', label: 'B', type: 'number' },
      { id: 'total', label: 'Total', type: 'formula', formula: 'a + b' },
    ];
    const data = [{ a: 10, b: 20, total: '' }];
    const csv = exportToCSV(makeSchema(formulaCols, data));
    const lines = csv.split('\n');
    expect(lines[1]).toBe('10,20,30');
  });
});

describe('exportToMarkdown', () => {
  it('generates header row with pipes', () => {
    const md = exportToMarkdown(makeSchema(cols, rows));
    const lines = md.split('\n');
    expect(lines[0]).toBe('| Name | Score | Done |');
  });

  it('generates separator row', () => {
    const md = exportToMarkdown(makeSchema(cols, rows));
    const lines = md.split('\n');
    expect(lines[1]).toBe('| --- | --- | --- |');
  });

  it('generates data rows', () => {
    const md = exportToMarkdown(makeSchema(cols, rows));
    const lines = md.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 data
  });

  it('converts checkboxes to emoji', () => {
    const md = exportToMarkdown(makeSchema(cols, rows));
    const lines = md.split('\n');
    expect(lines[2]).toContain('✅');
    expect(lines[3]).toContain('⬜');
  });

  it('handles empty data', () => {
    const md = exportToMarkdown(makeSchema(cols, []));
    const lines = md.split('\n');
    expect(lines).toHaveLength(2); // header + separator
  });

  it('evaluates formula columns', () => {
    const formulaCols: ColumnDef[] = [
      { id: 'a', label: 'A', type: 'number' },
      { id: 'b', label: 'B', type: 'number' },
      { id: 'total', label: 'Total', type: 'formula', formula: 'a + b' },
    ];
    const data = [{ a: 5, b: 3, total: '' }];
    const md = exportToMarkdown(makeSchema(formulaCols, data));
    expect(md).toContain('| 5 | 3 | 8 |');
  });

  it('handles progress columns with formula', () => {
    const progressCols: ColumnDef[] = [
      { id: 'read', label: 'Read', type: 'number' },
      { id: 'total', label: 'Total', type: 'number' },
      { id: 'pct', label: '%', type: 'progress', formula: 'read / total * 100' },
    ];
    const data = [{ read: 50, total: 100, pct: 0 }];
    const md = exportToMarkdown(makeSchema(progressCols, data));
    expect(md).toContain('50');
  });
});
