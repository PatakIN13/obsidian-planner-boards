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

export interface PlannerSchema {
  type?: string;
  title?: string;
  theme?: string;
  locale?: string;
  template?: string;
  columns: ColumnDef[];
  summary?: SummaryDef[];
  data: Record<string, any>[];
  // Template-specific fields (passed through)
  [key: string]: any;
}

export interface CellValue {
  raw: any;
  computed?: any;
}

export interface FormulaContext {
  row: Record<string, any>;
  allRows: Record<string, any>[];
  columns: ColumnDef[];
}
