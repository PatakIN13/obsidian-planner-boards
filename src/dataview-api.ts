import type PlannerBoardsPlugin from './main';
import { parseSchema } from './parser/schema-parser';
import { expandTemplate } from './templates/template-registry';
import { TFile } from 'obsidian';

/**
 * Dataview integration — exposes planner data via plugin API.
 * 
 * Usage in Dataview JS:
 * ```dataviewjs
 * const planner = app.plugins.plugins['planner-boards'];
 * const data = await planner.api.getPlannerData('path/to/file.planner');
 * dv.table(data.columns.map(c => c.label), data.rows);
 * ```
 */
export class PlannerAPI {
  constructor(private plugin: PlannerBoardsPlugin) {}

  /**
   * Get parsed planner data from a file.
   * Returns { title, columns, rows, summary } ready for Dataview tables.
   */
  async getPlannerData(filePath: string): Promise<PlannerDataResult | null> {
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;

    const content = await this.plugin.app.vault.read(file);
    const blocks = this.extractPlannerBlocks(content);
    if (blocks.length === 0) return null;

    const results: PlannerDataResult[] = [];
    for (const block of blocks) {
      let schema = parseSchema(block);
      if (schema.template) schema = expandTemplate(schema);

      results.push({
        title: schema.title || '',
        columns: schema.columns.map(c => ({ id: c.id, label: c.label, type: c.type })),
        rows: schema.data.map(row => schema.columns.map(c => row[c.id])),
        data: schema.data,
        summary: schema.summary || [],
      });
    }

    return results.length === 1 ? results[0] : results[0];
  }

  /**
   * Get all planner data from all files in a folder.
   */
  async getAllPlannerData(folderPath: string): Promise<PlannerDataResult[]> {
    const results: PlannerDataResult[] = [];
    const files = this.plugin.app.vault.getFiles()
      .filter(f => f.path.startsWith(folderPath) && (f.extension === 'planner' || f.extension === 'md'));

    for (const file of files) {
      const data = await this.getPlannerData(file.path);
      if (data) results.push(data);
    }
    return results;
  }

  /**
   * Get all board files.
   */
  getBoardFiles(): string[] {
    return this.plugin.app.vault.getFiles()
      .filter(f => f.extension === 'planner-board')
      .map(f => f.path);
  }

  private extractPlannerBlocks(content: string): string[] {
    const blocks: string[] = [];
    const regex = /```planner\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      blocks.push(match[1].trim());
    }
    return blocks;
  }
}

export interface PlannerDataResult {
  title: string;
  columns: { id: string; label: string; type: string }[];
  rows: any[][];
  data: Record<string, any>[];
  summary: any[];
}
