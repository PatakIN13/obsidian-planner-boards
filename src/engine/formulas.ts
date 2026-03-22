import { ColumnDef, FormulaContext } from '../types';

/**
 * Evaluate a formula string in the context of a row and all data rows.
 */
export function evaluateFormula(formula: string, ctx: FormulaContext): number | null {
  try {
    const resolved = resolveFormula(formula, ctx);
    if (resolved === null) return null;
    return resolved;
  } catch {
    return null;
  }
}

function resolveFormula(formula: string, ctx: FormulaContext): number | null {
  // SUM(col)
  let match = formula.match(/^SUM\((\w+)\)$/i);
  if (match) {
    return sumColumn(match[1], ctx);
  }

  // AVG(col)
  match = formula.match(/^AVG\((\w+)\)$/i);
  if (match) {
    return avgColumn(match[1], ctx);
  }

  // COUNT(col)
  match = formula.match(/^COUNT\((\w+)\)$/i);
  if (match) {
    return countColumn(match[1], ctx);
  }

  // COUNTIF(col, true) or COUNTIF(col:col2, true)
  match = formula.match(/^COUNTIF\((\w+)(?::(\w+))?,\s*(true|false|\d+(?:\.\d+)?|"[^"]*")\)$/i);
  if (match) {
    return countIfColumns(match[1], match[2], match[3], ctx);
  }

  // COUNTIF(col:col2, value)
  match = formula.match(/^COUNTIF\((\w+):(\w+),\s*(true|false|\d+(?:\.\d+)?|"[^"]*")\)$/i);
  if (match) {
    return countIfColumns(match[1], match[2], match[3], ctx);
  }

  // MIN(col)
  match = formula.match(/^MIN\((\w+)\)$/i);
  if (match) {
    return minColumn(match[1], ctx);
  }

  // MAX(col)
  match = formula.match(/^MAX\((\w+)\)$/i);
  if (match) {
    return maxColumn(match[1], ctx);
  }

  // ROUND(expr) or ROUND(expr, decimals)
  match = formula.match(/^ROUND\((.+?)(?:,\s*(\d+))?\)$/i);
  if (match) {
    const inner = resolveFormula(match[1].trim(), ctx);
    if (inner === null) return null;
    const decimals = match[2] ? parseInt(match[2]) : 0;
    return Math.round(inner * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }

  // AVG(col1:col2) — average across columns in a single row
  match = formula.match(/^AVG\((\w+):(\w+)\)$/i);
  if (match) {
    return avgColumnsInRow(match[1], match[2], ctx);
  }

  // Arithmetic expression: try to evaluate with column references
  return evaluateArithmetic(formula, ctx);
}

function evaluateArithmetic(expr: string, ctx: FormulaContext): number | null {
  // Replace column references with their values from the current row
  let resolved = expr;
  for (const col of ctx.columns) {
    const regex = new RegExp(`\\b${col.id}\\b`, 'g');
    const val = ctx.row[col.id];
    if (regex.test(resolved)) {
      const numVal = toNumber(val);
      if (numVal === null) {
        resolved = resolved.replace(regex, '0');
      } else {
        resolved = resolved.replace(regex, String(numVal));
      }
    }
  }

  // Safety: only allow numbers, operators, parens, spaces
  if (!/^[\d\s+\-*/().]+$/.test(resolved)) {
    return null;
  }

  return safeEvalArithmetic(resolved);
}

function getColumnRange(startId: string, endId: string | undefined, ctx: FormulaContext): string[] {
  if (!endId) return [startId];
  const colIds = ctx.columns.map(c => c.id);
  const startIdx = colIds.indexOf(startId);
  const endIdx = colIds.indexOf(endId);
  if (startIdx === -1 || endIdx === -1) return [startId];
  return colIds.slice(Math.min(startIdx, endIdx), Math.max(startIdx, endIdx) + 1);
}

function countIfColumns(startCol: string, endCol: string | undefined, condition: string, ctx: FormulaContext): number {
  const cols = getColumnRange(startCol, endCol, ctx);
  let condValue: string | number | boolean;
  if (condition === 'true') condValue = true;
  else if (condition === 'false') condValue = false;
  else if (condition.startsWith('"')) condValue = condition.slice(1, -1);
  else condValue = parseFloat(condition);

  let count = 0;
  for (const colId of cols) {
    const val = ctx.row[colId];
    if (val === condValue) count++;
  }
  return count;
}

function sumColumn(colId: string, ctx: FormulaContext): number {
  let sum = 0;
  for (const row of ctx.allRows) {
    const n = toNumber(row[colId]);
    if (n !== null) sum += n;
  }
  return sum;
}

function avgColumn(colId: string, ctx: FormulaContext): number | null {
  let sum = 0;
  let count = 0;
  for (const row of ctx.allRows) {
    const n = toNumber(row[colId]);
    if (n !== null) { sum += n; count++; }
  }
  return count > 0 ? sum / count : null;
}

function avgColumnsInRow(startId: string, endId: string, ctx: FormulaContext): number | null {
  const cols = getColumnRange(startId, endId, ctx);
  let sum = 0;
  let count = 0;
  for (const colId of cols) {
    const n = toNumber(ctx.row[colId]);
    if (n !== null) { sum += n; count++; }
  }
  return count > 0 ? sum / count : null;
}

function countColumn(colId: string, ctx: FormulaContext): number {
  let count = 0;
  for (const row of ctx.allRows) {
    if (row[colId] !== undefined && row[colId] !== null && row[colId] !== '') count++;
  }
  return count;
}

function minColumn(colId: string, ctx: FormulaContext): number | null {
  let min: number | null = null;
  for (const row of ctx.allRows) {
    const n = toNumber(row[colId]);
    if (n !== null && (min === null || n < min)) min = n;
  }
  return min;
}

function maxColumn(colId: string, ctx: FormulaContext): number | null {
  let max: number | null = null;
  for (const row of ctx.allRows) {
    const n = toNumber(row[colId]);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Evaluate a summary formula over all rows for a given column.
 */
export function evaluateSummaryFormula(formula: string, colId: string, allRows: Record<string, string | number | boolean>[], columns: ColumnDef[]): number | null {
  const ctx: FormulaContext = {
    row: {},
    allRows,
    columns,
  };
  return resolveFormula(formula, ctx);
}

/**
 * Safe arithmetic expression evaluator using recursive descent parsing.
 * Only handles numbers, +, -, *, /, and parentheses.
 */
function safeEvalArithmetic(expr: string): number | null {
  type Token = { type: 'num'; value: number } | { type: 'op'; value: string };
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === ' ') { i++; continue; }
    if ('+-*/()'.includes(expr[i])) {
      tokens.push({ type: 'op', value: expr[i] });
      i++;
    } else if (/[\d.]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) { num += expr[i++]; }
      const val = parseFloat(num);
      if (isNaN(val)) return null;
      tokens.push({ type: 'num', value: val });
    } else {
      return null;
    }
  }

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const advance = (): Token => tokens[pos++];

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = peek();
      if (!t || t.type !== 'op' || (t.value !== '+' && t.value !== '-')) break;
      const op = advance().value;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = peek();
      if (!t || t.type !== 'op' || (t.value !== '*' && t.value !== '/')) break;
      const op = advance().value;
      const right = parseFactor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number | null {
    if (pos >= tokens.length) return null;
    const t = peek()!;
    if (t.type === 'num') { advance(); return t.value; }
    if (t.type === 'op' && t.value === '(') {
      advance();
      const r = parseExpr();
      if (r === null || pos >= tokens.length || peek()?.value !== ')') return null;
      advance();
      return r;
    }
    if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
      advance();
      const f = parseFactor();
      if (f === null) return null;
      return t.value === '-' ? -f : f;
    }
    return null;
  }

  const result = parseExpr();
  if (result === null || pos < tokens.length) return null;
  return isFinite(result) ? result : null;
}

function toNumber(val: string | number | boolean): number | null {
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  return null;
}
