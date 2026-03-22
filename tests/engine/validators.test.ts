import { describe, it, expect } from 'vitest';
import { validateCellValue } from '../../src/engine/validators';
import { ColumnDef } from '../../src/types';

function col(overrides: Partial<ColumnDef> & { id: string; type: ColumnDef['type'] }): ColumnDef {
  return { label: overrides.id, ...overrides };
}

describe('validateCellValue — text', () => {
  const textCol = col({ id: 'name', type: 'text' });

  it('accepts a string', () => {
    const r = validateCellValue('hello', textCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('hello');
  });

  it('coerces number to string', () => {
    const r = validateCellValue(42, textCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('42');
  });

  it('coerces null to empty string', () => {
    const r = validateCellValue(null, textCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('');
  });

  it('coerces undefined to empty string', () => {
    const r = validateCellValue(undefined, textCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('');
  });
});

describe('validateCellValue — number', () => {
  const numCol = col({ id: 'qty', type: 'number' });

  it('accepts a valid number', () => {
    const r = validateCellValue(42, numCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe(42);
  });

  it('parses numeric string', () => {
    const r = validateCellValue('3.14', numCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe(3.14);
  });

  it('rejects non-numeric string', () => {
    const r = validateCellValue('abc', numCol);
    expect(r.valid).toBe(false);
    expect(r.coerced).toBe(0);
  });

  it('clamps to min', () => {
    const c = col({ id: 'qty', type: 'number', min: 0 });
    const r = validateCellValue(-5, c);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe(0);
  });

  it('clamps to max', () => {
    const c = col({ id: 'qty', type: 'number', max: 100 });
    const r = validateCellValue(200, c);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe(100);
  });

  it('clamps within min-max range', () => {
    const c = col({ id: 'qty', type: 'number', min: 1, max: 10 });
    expect(validateCellValue(0, c).coerced).toBe(1);
    expect(validateCellValue(11, c).coerced).toBe(10);
    expect(validateCellValue(5, c).coerced).toBe(5);
  });
});

describe('validateCellValue — checkbox', () => {
  const cbCol = col({ id: 'done', type: 'checkbox' });

  it('coerces truthy values to true', () => {
    expect(validateCellValue(true, cbCol).coerced).toBe(true);
    expect(validateCellValue(1, cbCol).coerced).toBe(true);
    expect(validateCellValue('yes', cbCol).coerced).toBe(true);
  });

  it('coerces falsy values to false', () => {
    expect(validateCellValue(false, cbCol).coerced).toBe(false);
    expect(validateCellValue(0, cbCol).coerced).toBe(false);
    expect(validateCellValue('', cbCol).coerced).toBe(false);
    expect(validateCellValue(null, cbCol).coerced).toBe(false);
  });

  it('always reports valid', () => {
    expect(validateCellValue(true, cbCol).valid).toBe(true);
    expect(validateCellValue(null, cbCol).valid).toBe(true);
  });
});

describe('validateCellValue — select', () => {
  const selCol = col({ id: 'status', type: 'select', options: ['open', 'closed'] });

  it('accepts a valid option', () => {
    const r = validateCellValue('open', selCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('open');
  });

  it('rejects an invalid option', () => {
    const r = validateCellValue('pending', selCol);
    expect(r.valid).toBe(false);
    expect(r.coerced).toBe('pending');
  });

  it('accepts any value when options not specified', () => {
    const c = col({ id: 'status', type: 'select' });
    const r = validateCellValue('anything', c);
    expect(r.valid).toBe(true);
  });
});

describe('validateCellValue — progress', () => {
  const progCol = col({ id: 'prog', type: 'progress', min: 0, max: 100 });

  it('clamps progress to range', () => {
    expect(validateCellValue(150, progCol).coerced).toBe(100);
    expect(validateCellValue(-10, progCol).coerced).toBe(0);
    expect(validateCellValue(50, progCol).coerced).toBe(50);
  });
});

describe('validateCellValue — date', () => {
  const dateCol = col({ id: 'due', type: 'date' });

  it('accepts date string', () => {
    const r = validateCellValue('2024-01-15', dateCol);
    expect(r.valid).toBe(true);
    expect(r.coerced).toBe('2024-01-15');
  });
});

describe('validateCellValue — formula', () => {
  const formulaCol = col({ id: 'total', type: 'formula' });

  it('marks formula cells as invalid (read-only)', () => {
    expect(validateCellValue(42, formulaCol).valid).toBe(false);
    expect(validateCellValue('text', formulaCol).valid).toBe(false);
    expect(validateCellValue(true, formulaCol).valid).toBe(false);
  });

  it('preserves the value in coerced', () => {
    expect(validateCellValue(42, formulaCol).coerced).toBe(42);
    expect(validateCellValue(true, formulaCol).coerced).toBe(true);
  });
});

describe('validateCellValue — unknown type', () => {
  const unknownCol = { id: 'x', label: 'X', type: 'unknown' as ColumnDef['type'] };

  it('accepts numbers', () => {
    expect(validateCellValue(42, unknownCol).valid).toBe(true);
    expect(validateCellValue(42, unknownCol).coerced).toBe(42);
  });

  it('accepts booleans', () => {
    expect(validateCellValue(true, unknownCol).valid).toBe(true);
    expect(validateCellValue(true, unknownCol).coerced).toBe(true);
  });

  it('accepts strings', () => {
    expect(validateCellValue('text', unknownCol).valid).toBe(true);
    expect(validateCellValue('text', unknownCol).coerced).toBe('text');
  });
});
