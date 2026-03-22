import { describe, it, expect } from 'vitest';
import { evaluateFormula, evaluateSummaryFormula } from '../../src/engine/formulas';
import { ColumnDef, FormulaContext } from '../../src/types';

function makeCtx(
  row: Record<string, string | number | boolean> = {},
  allRows: Record<string, string | number | boolean>[] = [],
  columns: ColumnDef[] = [],
): FormulaContext {
  return { row, allRows: allRows.length ? allRows : [row], columns };
}

const numColumns: ColumnDef[] = [
  { id: 'a', label: 'A', type: 'number' },
  { id: 'b', label: 'B', type: 'number' },
  { id: 'c', label: 'C', type: 'number' },
];

describe('evaluateFormula — arithmetic via safeEvalArithmetic', () => {
  it('basic addition: 2 + 3 → 5', () => {
    expect(evaluateFormula('2 + 3', makeCtx({}, [], []))).toBe(5);
  });

  it('basic subtraction: 10 - 4 → 6', () => {
    expect(evaluateFormula('10 - 4', makeCtx({}, [], []))).toBe(6);
  });

  it('basic multiplication: 3 * 7 → 21', () => {
    expect(evaluateFormula('3 * 7', makeCtx({}, [], []))).toBe(21);
  });

  it('basic division: 15 / 3 → 5', () => {
    expect(evaluateFormula('15 / 3', makeCtx({}, [], []))).toBe(5);
  });

  it('operator precedence: 2 + 3 * 4 → 14', () => {
    expect(evaluateFormula('2 + 3 * 4', makeCtx({}, [], []))).toBe(14);
  });

  it('parentheses: (2 + 3) * 4 → 20', () => {
    expect(evaluateFormula('(2 + 3) * 4', makeCtx({}, [], []))).toBe(20);
  });

  it('negative result: 3 - 10 → -7', () => {
    expect(evaluateFormula('3 - 10', makeCtx({}, [], []))).toBe(-7);
  });

  it('division by zero returns null (non-finite)', () => {
    expect(evaluateFormula('5 / 0', makeCtx({}, [], []))).toBeNull();
  });

  it('invalid input "abc" returns null', () => {
    expect(evaluateFormula('abc', makeCtx({}, [], []))).toBeNull();
  });

  it('empty string returns null', () => {
    expect(evaluateFormula('', makeCtx({}, [], []))).toBeNull();
  });

  it('decimals: 1.5 + 2.5 → 4', () => {
    expect(evaluateFormula('1.5 + 2.5', makeCtx({}, [], []))).toBe(4);
  });

  it('complex: (10 + 5) * 2 / 3 → 10', () => {
    expect(evaluateFormula('(10 + 5) * 2 / 3', makeCtx({}, [], []))).toBe(10);
  });

  it('unary minus: -5 + 3 → -2', () => {
    expect(evaluateFormula('-5 + 3', makeCtx({}, [], []))).toBe(-2);
  });
});

describe('evaluateFormula — column references', () => {
  it('resolves column ids in arithmetic', () => {
    const ctx = makeCtx({ a: 10, b: 3, c: 0 }, [], numColumns);
    expect(evaluateFormula('a + b', ctx)).toBe(13);
  });

  it('treats missing column values as 0', () => {
    const ctx = makeCtx({ a: 5, b: '', c: 0 }, [], numColumns);
    expect(evaluateFormula('a + b', ctx)).toBe(5);
  });

  it('column arithmetic with multiplication', () => {
    const ctx = makeCtx({ a: 4, b: 5, c: 0 }, [], numColumns);
    expect(evaluateFormula('a * b', ctx)).toBe(20);
  });
});

describe('evaluateFormula — SUM', () => {
  it('sums a column across all rows', () => {
    const rows = [{ a: 10 }, { a: 20 }, { a: 30 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('SUM(a)', ctx)).toBe(60);
  });

  it('ignores non-numeric values', () => {
    const rows = [{ a: 10 }, { a: 'hello' }, { a: 30 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('SUM(a)', ctx)).toBe(40);
  });
});

describe('evaluateFormula — AVG', () => {
  it('averages a column', () => {
    const rows = [{ a: 10 }, { a: 20 }, { a: 30 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('AVG(a)', ctx)).toBe(20);
  });

  it('returns null for empty data', () => {
    const ctx = makeCtx({}, [], numColumns);
    expect(evaluateFormula('AVG(a)', ctx)).toBeNull();
  });
});

describe('evaluateFormula — COUNT', () => {
  it('counts non-empty values', () => {
    const rows = [{ a: 10 }, { a: '' }, { a: 30 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('COUNT(a)', ctx)).toBe(2);
  });
});

describe('evaluateFormula — MIN / MAX', () => {
  it('finds minimum', () => {
    const rows = [{ a: 30 }, { a: 10 }, { a: 20 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('MIN(a)', ctx)).toBe(10);
  });

  it('finds maximum', () => {
    const rows = [{ a: 30 }, { a: 10 }, { a: 20 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('MAX(a)', ctx)).toBe(30);
  });

  it('MIN returns null for no numeric values', () => {
    const rows = [{ a: '' }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('MIN(a)', ctx)).toBeNull();
  });
});

describe('evaluateFormula — ROUND', () => {
  it('rounds to 0 decimals by default', () => {
    const rows = [{ a: 3 }, { a: 7 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('ROUND(AVG(a))', ctx)).toBe(5);
  });

  it('rounds to specified decimals', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const ctx = makeCtx(rows[0], rows, numColumns);
    expect(evaluateFormula('ROUND(AVG(a), 1)', ctx)).toBe(2);
  });
});

describe('evaluateFormula — COUNTIF', () => {
  it('counts matching boolean values', () => {
    const cols: ColumnDef[] = [{ id: 'done', label: 'Done', type: 'checkbox' }];
    const rows = [{ done: true }, { done: false }, { done: true }];
    const ctx = makeCtx(rows[0], rows, cols);
    // COUNTIF on a single column in current row
    expect(evaluateFormula('COUNTIF(done, true)', ctx)).toBe(1);
  });
});

describe('evaluateFormula — AVG across columns in row', () => {
  it('averages values across columns a:c', () => {
    const ctx = makeCtx({ a: 10, b: 20, c: 30 }, [], numColumns);
    expect(evaluateFormula('AVG(a:c)', ctx)).toBe(20);
  });
});

describe('evaluateSummaryFormula', () => {
  it('computes SUM over all rows', () => {
    const rows = [{ score: 10 }, { score: 20 }, { score: 30 }];
    const cols: ColumnDef[] = [{ id: 'score', label: 'Score', type: 'number' }];
    expect(evaluateSummaryFormula('SUM(score)', 'score', rows, cols)).toBe(60);
  });

  it('computes AVG over all rows', () => {
    const rows = [{ score: 10 }, { score: 20 }];
    const cols: ColumnDef[] = [{ id: 'score', label: 'Score', type: 'number' }];
    expect(evaluateSummaryFormula('AVG(score)', 'score', rows, cols)).toBe(15);
  });
});
