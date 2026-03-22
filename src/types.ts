// Core types for Planner Boards plugin

export type CellType = 'text' | 'number' | 'checkbox' | 'select' | 'date' | 'formula' | 'progress' | 'combo';

export interface ColumnDef {
  id: string;
  label: string;
  type: CellType;
  width?: number;
  frozen?: boolean;
  group?: string;
  // For select
  options?: string[];
  // For combo — reference another subtable's column for dynamic options
  refTable?: string;
  refTables?: string[];
  refColumn?: string;
  selectOnly?: boolean;  // combo: show dropdown only, no free text
  multiSelect?: boolean; // combo: allow multiple values (pipe-separated)
  // For number / progress
  min?: number;
  max?: number;
  // For formula
  formula?: string;
  format?: string;
  // For conditional formatting
  color_scale?: Record<number, string>;
  highlight_if?: string;
}

export interface SummaryDef {
  column: string;
  formula: string;
  label?: string;
}

export interface SubtableControl {
  type: 'select';
  field: string;
  value: string | number;
  options: { label: string; value: string | number }[];
}

export interface SubtableEntry {
  title: string;
  columns: ColumnDef[];
  data: Record<string, string | number | boolean>[];
  group?: string;
  groupCol?: string;
  noAddRow?: boolean;
  controls?: SubtableControl[];
  onAddItem?: () => void;
}

export interface PlannerSchema {
  type?: string;
  title?: string;
  theme?: string;
  locale?: string;
  template?: string;
  columns: ColumnDef[];
  summary?: SummaryDef[];
  data: Record<string, string | number | boolean>[];
  _subtables?: SubtableEntry[];
  sections?: Record<string, Array<Record<string, string | number | boolean>>>;
  // Template-specific fields (passed through)
  [key: string]: unknown;
}

export interface CellValue {
  raw: string | number | boolean;
  computed?: string | number | boolean;
}

export interface FormulaContext {
  row: Record<string, string | number | boolean>;
  allRows: Record<string, string | number | boolean>[];
  columns: ColumnDef[];
}
