import { App, TFile, TFolder, normalizePath } from 'obsidian';
import * as yaml from 'js-yaml';

const DEFAULT_TEMPLATES_FOLDER = '_planner-templates';

/**
 * Save a planner YAML source as a custom template file in the vault.
 */
export async function saveCustomTemplate(
  app: App,
  name: string,
  source: string,
  folder?: string
): Promise<void> {
  const dir = folder || DEFAULT_TEMPLATES_FOLDER;
  const dirPath = normalizePath(dir);

  // Ensure directory exists
  if (!app.vault.getAbstractFileByPath(dirPath)) {
    await app.vault.createFolder(dirPath);
  }

  const fileName = normalizePath(`${dir}/${sanitizeName(name)}.yaml`);
  const existing = app.vault.getAbstractFileByPath(fileName);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, source);
  } else {
    await app.vault.create(fileName, source);
  }
}

/**
 * Load all custom template names from the vault folder.
 */
export async function listCustomTemplates(
  app: App,
  folder?: string
): Promise<string[]> {
  const dir = folder || DEFAULT_TEMPLATES_FOLDER;
  const dirPath = normalizePath(dir);
  const abstract = app.vault.getAbstractFileByPath(dirPath);
  if (!abstract || !(abstract instanceof TFolder)) return [];

  const names: string[] = [];
  for (const child of abstract.children) {
    if (child instanceof TFile && child.extension === 'yaml') {
      names.push(child.basename);
    }
  }
  return names.sort();
}

/**
 * Load a custom template YAML from the vault.
 */
export async function loadCustomTemplate(
  app: App,
  name: string,
  folder?: string
): Promise<string> {
  const dir = folder || DEFAULT_TEMPLATES_FOLDER;
  const fileName = normalizePath(`${dir}/${sanitizeName(name)}.yaml`);
  const file = app.vault.getAbstractFileByPath(fileName);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Template not found: ${name}`);
  }
  return app.vault.read(file);
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}
