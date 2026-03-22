import { Plugin, MarkdownPostProcessorContext, MarkdownView, Modal, App, Setting, Notice, Menu, WorkspaceLeaf, TFolder, TFile, Editor } from 'obsidian';
import { createPlanner } from './engine/planner-engine';
import { parseSchema } from './parser/schema-parser';
import { PlannerBoardsSettings, DEFAULT_SETTINGS, PlannerBoardsSettingTab } from './settings';
import { exportToCSV, exportToMarkdown } from './utils/export';
import { saveCustomTemplate, listCustomTemplates, loadCustomTemplate } from './utils/custom-templates';
import { expandTemplate } from './templates/template-registry';
import { CalendarSyncEngine } from './calendar/calendar-sync';
import { DEFAULT_CALENDAR_SETTINGS } from './calendar/calendar-types';
import { PlannerBoardsView, VIEW_TYPE_PLANNER } from './planner-view';
import { BoardView, VIEW_TYPE_BOARD, PlannerFileView, VIEW_TYPE_PLANNER_FILE } from './single-planner-view';
import { t, tArray, setLocale, Locale } from './i18n';
import { PlannerAPI } from './dataview-api';

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const TEMPLATES: Record<string, { label: string; description: string; generator: (settings: PlannerBoardsSettings, month?: string) => string }> = {
  'daily-planner': {
    label: t('tmpl.daily-planner'),
    description: t('tmpl.daily-planner.desc'),
    generator: (s, month?) => {
      const m = month || currentMonth();
      return `template: daily-planner\nmonth: ${m}\ntheme: ${s.defaultTheme}`;
    },
  },
  'daily-finance': {
    label: '💰 ' + (t('tmpl.daily-planner') === 'Ежедневник' ? 'Финансы (день)' : 'Daily Finance'),
    description: t('tmpl.daily-planner') === 'Ежедневник' ? 'Ежедневная запись финансов: доходы, расходы, долги, накопления' : 'Daily finance entry: income, expenses, debts, savings',
    generator: (s, month?) => {
      const m = month || currentMonth();
      return `template: daily-finance\nmonth: ${m}\ntheme: ${s.defaultTheme}`;
    },
  },
  'finance-planner': {
    label: t('tmpl.finance-planner'),
    description: t('tmpl.finance-planner.desc'),
    generator: (s, month?) => {
      const m = month || currentMonth();
      return `template: finance-planner\nmonth: ${m}\ncurrency: "${s.defaultCurrency}"\ntheme: ${s.defaultTheme}\nsections:\n  income:\n    - category: "${t('tmplData.salary')}"\n      planned: 0\n      actual: 0\n    - category: "${t('tmplData.freelance')}"\n      planned: 0\n      actual: 0\n  fixed_expenses:\n    - category: "${t('tmplData.rent')}"\n      planned: 0\n      actual: 0\n    - category: "${t('tmplData.utilities')}"\n      planned: 0\n      actual: 0\n    - category: "${t('tmplData.internet')}"\n      planned: 0\n      actual: 0\n  variable_expenses:\n    - category: "${t('tmplData.groceries')}"\n      planned: 0\n      actual: 0\n    - category: "${t('tmplData.restaurants')}"\n      planned: 0\n      actual: 0\n    - category: "${t('tmplData.entertainment')}"\n      planned: 0\n      actual: 0\n  debts:\n    - creditor: "${t('tmplData.creditCard')}"\n      payment: 0\n      paid: 0\n  savings:\n    - goal: "${t('tmplData.emergencyFund')}"\n      target: 0\n      current: 0`;
    },
  },
  'project-tracker': {
    label: t('tmpl.project-tracker'),
    description: t('tmpl.project-tracker.desc'),
    generator: (s, month?) => {
      const y = month ? month.split('-')[0] : String(new Date().getFullYear());
      return `template: project-tracker\nyear: ${y}\nproject: "${t('tmplData.myProject')}"\ntheme: ${s.defaultTheme}\nassignees:\n  - "${t('tmplData.assignee1')}"\ntasks:\n  - task: "${t('tmplData.task1')}"\n    status: "${t('tmplData.statusWaiting')}"\n    priority: "${t('tmplData.priorityMedium')}"\n    progress: 0`;
    },
  },
  'reading-log': {
    label: t('tmpl.reading-log'),
    description: t('tmpl.reading-log.desc'),
    generator: (s, month?) => {
      const y = month ? month.split('-')[0] : String(new Date().getFullYear());
      return `template: reading-log\nyear: ${y}\ntheme: ${s.defaultTheme}\nbooks:\n  - title: "${t('tmplData.bookTitle')}"\n    author: "${t('tmplData.bookAuthor')}"\n    status: "${t('tmplData.bookStatusQueue')}"\n    pages: 300\n    read: 0`;
    },
  },
  'goal-tracker': {
    label: t('tmpl.goal-tracker'),
    description: t('tmpl.goal-tracker.desc'),
    generator: (s, month?) => {
      const y = month ? month.split('-')[0] : String(new Date().getFullYear());
      return `template: goal-tracker\nyear: ${y}\ntheme: ${s.defaultTheme}\ngoals:\n  - objective: "${t('tmplData.okrObjective')}"\n    key_result: "${t('tmplData.okrKeyResult')}"\n    quarter: Q1\n    target: 100\n    current: 0`;
    },
  },
  'custom': {
    label: t('tmpl.custom'),
    description: t('tmpl.custom.desc'),
    generator: (s, month?) => {
      const m = month || currentMonth();
      return `type: grid\ntitle: "${t('tmplData.myPlanner')}"\nmonth: ${m}\ntheme: ${s.defaultTheme}\n\ncolumns:\n  - id: name\n    label: "${t('tmplData.colName')}"\n    type: text\n    width: 200\n  - id: status\n    label: "${t('tmplData.colStatus')}"\n    type: checkbox\n\ndata:\n  - name: "${t('tmplData.element1')}"\n    status: false`;
    },
  },
};

export default class PlannerBoardsPlugin extends Plugin {
  settings: PlannerBoardsSettings = DEFAULT_SETTINGS;
  calendarSync: CalendarSyncEngine | null = null;
  api: PlannerAPI = null!;

  async onload() {
    await this.loadSettings();
    setLocale((this.settings.uiLanguage || 'ru') as Locale);
    this.initCalendarSync();
    this.api = new PlannerAPI(this);

    this.registerMarkdownCodeBlockProcessor('planner', (source, el, ctx) => {
      this.processCodeBlock(source, el, ctx);
    });

    this.addSettingTab(new PlannerBoardsSettingTab(this.app, this));

    // Register full-page view
    this.registerView(VIEW_TYPE_PLANNER, (leaf) => new PlannerBoardsView(leaf, this));
    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.registerView(VIEW_TYPE_PLANNER_FILE, (leaf) => new PlannerFileView(leaf, this));

    // Auto-open board and planner files in custom views
    this.registerExtensions(['planner-board'], VIEW_TYPE_BOARD);
    this.registerExtensions(['planner'], VIEW_TYPE_PLANNER_FILE);

    // Ribbon icon in left sidebar
    this.addRibbonIcon('layout-grid', 'Planner boards', (evt) => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle(t('menu.planners')).setIcon('layout-grid')
        .onClick(() => { void this.activateView(); }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle(t('menu.syncCalendars')).setIcon('refresh-cw')
        .onClick(() => {
          void this.syncCalendars().then(() => {
            new Notice(t('notice.synced'));
          }).catch((e: unknown) => {
            new Notice(t('notice.error', { msg: e instanceof Error ? e.message : String(e) }));
          });
        }));
      menu.addItem(item => item.setTitle(t('menu.settings')).setIcon('settings')
        .onClick(() => {
          const appWithSetting = this.app as App & { setting?: { open(): void; openTabById?(id: string): void } };
          appWithSetting.setting?.open();
          appWithSetting.setting?.openTabById?.('planner-boards');
        }));
      menu.showAtMouseEvent(evt);
    });

    // Right-click context menu in file explorer
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        const folder = file instanceof TFolder ? file : file.parent;
        if (!folder) return;

        menu.addItem(item => {
          item.setTitle(t('menu.newBoard'))
            .setIcon('layout-grid')
            .onClick(async () => {
              await this.createBoardFile(folder);
            });
        });
      })
    );

    // Commands
    this.addCommand({
      id: 'insert-planner',
      name: 'Insert new planner',
      editorCallback: (editor) => {
        new LoadTemplateModal(this.app, this.settings, (yaml) => {
          const block = '```planner\n' + yaml + '\n```\n';
          editor.replaceSelection(block);
        }).open();
      },
    });

    // Export commands
    this.addCommand({
      id: 'export-csv',
      name: 'Export to CSV',
      editorCallback: (editor) => {
        const block = this.extractPlannerBlock(editor);
        if (!block) { new Notice(t('notice.cursorNotInBlock')); return; }
        try {
          let schema = parseSchema(block);
          if (schema.template) schema = expandTemplate(schema);
          const csv = exportToCSV(schema);
          void navigator.clipboard.writeText(csv);
          new Notice(t('notice.csvCopied'));
        } catch (e) {
          new Notice(t('notice.exportError', { msg: e instanceof Error ? e.message : 'unknown' }));
        }
      },
    });

    this.addCommand({
      id: 'export-markdown',
      name: 'Export to Markdown table',
      editorCallback: (editor) => {
        const block = this.extractPlannerBlock(editor);
        if (!block) { new Notice(t('notice.cursorNotInBlock')); return; }
        try {
          let schema = parseSchema(block);
          if (schema.template) schema = expandTemplate(schema);
          const md = exportToMarkdown(schema);
          void navigator.clipboard.writeText(md);
          new Notice(t('notice.mdCopied'));
        } catch (e) {
          new Notice(t('notice.exportError', { msg: e instanceof Error ? e.message : 'unknown' }));
        }
      },
    });

    // Custom template commands
    this.addCommand({
      id: 'save-as-template',
      name: 'Save as template',
      editorCallback: (editor) => {
        const block = this.extractPlannerBlock(editor);
        if (!block) { new Notice(t('notice.cursorNotInBlock')); return; }
        new SaveTemplateModal(this.app, block, this.settings).open();
      },
    });

    this.addCommand({
      id: 'import-csv',
      name: 'Import from CSV',
      editorCallback: (editor) => {
        new ImportCSVModal(this.app, this.settings, (yaml) => {
          editor.replaceSelection('```planner\n' + yaml + '\n```\n');
        }).open();
      },
    });

    // Calendar commands
    this.addCommand({
      id: 'sync-calendars',
      name: 'Sync calendars',
      callback: () => {
        void this.syncCalendars().then(() => {
          new Notice(t('notice.calendarsSynced'));
        }).catch((e: unknown) => {
          new Notice(t('notice.error', { msg: e instanceof Error ? e.message : String(e) }));
        });
      },
    });

    this.addCommand({
      id: 'open-planner-view',
      name: 'Open view',
      callback: () => { void this.activateView(); },
    });


    this.addCommand({
      id: 'insert-calendar-planner',
      name: 'Insert calendar week view',
      editorCallback: (editor) => {
        void this.generateCalendarWeekYaml().then((yaml) => {
          editor.replaceSelection('```planner\n' + yaml + '\n```\n');
        }).catch((e: unknown) => {
          new Notice(t('notice.error', { msg: e instanceof Error ? e.message : String(e) }));
        });
      },
    });
  }

  private processCodeBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    el.empty();
    el.addClass('planner-boards-root');

    createPlanner(source, el, {
      onDataChange: (newYaml: string) => {
        this.saveToCodeBlock(newYaml, ctx);
      },
    });
  }

  private saveToCodeBlock(newYaml: string, ctx: MarkdownPostProcessorContext) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;
    const fileContent = editor.getValue();

    const el = ctx.el as HTMLElement;
    const sectionInfo = ctx.getSectionInfo(el);
    if (!sectionInfo) return;

    const { lineStart, lineEnd } = sectionInfo;
    const lines = fileContent.split('\n');

    const before = lines.slice(0, lineStart + 1).join('\n');
    const after = lines.slice(lineEnd).join('\n');

    const trimmedYaml = newYaml.replace(/\n+$/, '');
    const newContent = before + '\n' + trimmedYaml + '\n' + after;

    editor.setValue(newContent);
  }

  async loadSettings() {
    const loaded: unknown = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded as Partial<PlannerBoardsSettings>);
    if (!this.settings.calendar) {
      this.settings.calendar = { ...DEFAULT_CALENDAR_SETTINGS };
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Extract the planner YAML source from the code block at the cursor position.
   */
  private extractPlannerBlock(editor: Editor): string | null {
    const cursor = editor.getCursor();
    const content = editor.getValue();
    const lines = content.split('\n');

    let blockStart = -1;
    let blockEnd = -1;

    for (let i = cursor.line; i >= 0; i--) {
      if (lines[i].trim().startsWith('```planner')) {
        blockStart = i;
        break;
      }
      if (i < cursor.line && lines[i].trim() === '```') {
        break;
      }
    }

    if (blockStart === -1) return null;

    for (let i = blockStart + 1; i < lines.length; i++) {
      if (lines[i].trim() === '```') {
        blockEnd = i;
        break;
      }
    }

    if (blockEnd === -1 || cursor.line > blockEnd) return null;

    return lines.slice(blockStart + 1, blockEnd).join('\n');
  }

  // --- Full-page view ---

  async activateView() {
    const { workspace } = this.app;

    // Reuse existing leaf if present
    const existing = workspace.getLeavesOfType(VIEW_TYPE_PLANNER);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
      void workspace.revealLeaf(leaf);
    } else {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({
        type: VIEW_TYPE_PLANNER,
        active: true,
      });
      void workspace.revealLeaf(leaf);
    }
  }

  async createBoardFile(folder: TFolder) {
    const boardFolder = folder.path;
    const content = `---\nplanner-board: true\nfolder: "${boardFolder}"\nshow-on-main: true\nshow-calendar: false\n---\n`;
    let fileName = `${boardFolder}/Planner Board.planner-board`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = `${boardFolder}/Planner Board ${counter}.planner-board`;
      counter++;
    }
    const file = await this.app.vault.create(fileName, content);
    new Notice(t('notice.boardCreated', { name: fileName }));
    const leaf = this.app.workspace.getLeaf('tab');
    if (file instanceof TFile) {
      await leaf.openFile(file);
    }
  }

  getTemplates() {
    return TEMPLATES;
  }

  openInsertModal() {
    // Open insert template modal (creates in active editor if available)
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      new LoadTemplateModal(this.app, this.settings, (yaml) => {
        const block = '```planner\n' + yaml + '\n```\n';
        view.editor.replaceSelection(block);
      }).open();
    } else {
      new Notice(t('notice.openNoteForInsert'));
    }
  }

  // --- Calendar integration ---

  private initCalendarSync() {
    this.calendarSync = new CalendarSyncEngine(
      this.settings.calendar,
      async (calSettings) => {
        this.settings.calendar = calSettings;
        await this.saveSettings();
      }
    );

    if (this.settings.calendar.sources.length > 0) {
      this.calendarSync.startAutoSync(() => { void this.syncCalendars(); });
    }
  }

  restartCalendarSync() {
    if (this.calendarSync) {
      this.calendarSync.updateSettings(this.settings.calendar);
      this.calendarSync.startAutoSync(() => { void this.syncCalendars(); });
    }
  }

  async syncCalendars() {
    if (!this.calendarSync) return;
    this.calendarSync.updateSettings(this.settings.calendar);
    await this.calendarSync.syncAll();
  }

  async generateCalendarWeekYaml(): Promise<string> {
    if (!this.calendarSync) throw new Error('Calendar sync not initialized');

    await this.syncCalendars();

    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 7);

    const events = this.calendarSync.getEventsInRange(monday, sunday);

    const dayNames = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const dayLabels = tArray('days.short');
    // Reorder from [Sun,Mon,...,Sat] to [Mon,...,Sun]
    const monToSunLabels = [...dayLabels.slice(1), dayLabels[0]];

    const dayEvents: Record<string, typeof events> = {};
    for (const d of dayNames) dayEvents[d] = [];

    for (const ev of events) {
      const diff = Math.floor((ev.start.getTime() - monday.getTime()) / 86_400_000);
      if (diff >= 0 && diff < 7) {
        dayEvents[dayNames[diff]].push(ev);
      }
    }

    let yaml = `type: grid\ntitle: "${t('ui.weekTitle', { date: monday.toISOString().split('T')[0] })}"\ntheme: ${this.settings.defaultTheme}\n\ncolumns:\n  - id: time\n    label: "${t('ui.timeColumn')}"\n    type: text\n    width: 80\n    frozen: true\n`;

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      yaml += `  - id: ${dayNames[i]}\n    label: "${monToSunLabels[i]} ${d.getDate()}"\n    type: text\n    width: 140\n`;
    }

    const timeSlots = new Set<string>();
    for (const ev of events) {
      if (!ev.allDay) {
        const t = ev.start;
        timeSlots.add(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
      } else {
        timeSlots.add(t('ui.allDay'));
      }
    }

    const sortedTimes = Array.from(timeSlots).sort();
    if (sortedTimes.length === 0) sortedTimes.push('09:00');

    yaml += '\ndata:\n';
    for (const time of sortedTimes) {
      yaml += `  - time: "${time}"\n`;
      for (const day of dayNames) {
        const eventsAtTime = dayEvents[day].filter(ev => {
          if (time === t('ui.allDay')) return ev.allDay;
          if (ev.allDay) return false;
          const t = ev.start;
          const evTime = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
          return evTime === time;
        });
        if (eventsAtTime.length > 0) {
          yaml += `    ${day}: "${eventsAtTime.map(e => e.summary).join(', ')}"\n`;
        }
      }
    }

    return yaml;
  }

  onunload() {
    if (this.calendarSync) {
      this.calendarSync.stopAutoSync();
    }
  }
}

class SaveTemplateModal extends Modal {
  private source: string;
  private settings: PlannerBoardsSettings;

  constructor(app: App, source: string, settings: PlannerBoardsSettings) {
    super(app);
    this.source = source;
    this.settings = settings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('modal.saveTemplate') });

    let name = '';

    new Setting(contentEl)
      .setName(t('modal.templateName'))
      .addText(text => text
        .setPlaceholder(t('modal.templateNamePlaceholder'))
        .onChange(val => { name = val; }));

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText(t('btn.save'))
        .setCta()
        .onClick(async () => {
          if (!name.trim()) {
            new Notice(t('notice.enterTemplateName'));
            return;
          }
          try {
            await saveCustomTemplate(this.app, name, this.source, this.settings.templatesFolder);
            new Notice(t('notice.templateSaved', { name }));
            this.close();
          } catch (e) {
            new Notice(t('notice.error', { msg: e instanceof Error ? e.message : 'unknown' }));
          }
        }))
      .addButton(btn => btn
        .setButtonText(t('btn.cancel'))
        .onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

class LoadTemplateModal extends Modal {
  private settings: PlannerBoardsSettings;
  private onInsert: (yaml: string) => void;

  constructor(app: App, settings: PlannerBoardsSettings, onInsert: (yaml: string) => void) {
    super(app);
    this.settings = settings;
    this.onInsert = onInsert;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('modal.loadTemplate') });

    // Built-in templates
    contentEl.createEl('h3', { text: t('modal.builtIn') });
    for (const [, tmpl] of Object.entries(TEMPLATES)) {
      const item = contentEl.createDiv({ cls: 'planner-template-item' });
      item.createEl('span', { text: tmpl.label, cls: 'planner-template-item-label' });
      item.addEventListener('click', () => {
        this.onInsert(tmpl.generator(this.settings));
        this.close();
      });
    }

    // Custom templates
    try {
      const custom = await listCustomTemplates(this.app, this.settings.templatesFolder);
      if (custom.length > 0) {
        contentEl.createEl('h3', { text: t('modal.custom') });
        for (const name of custom) {
          const item = contentEl.createDiv({ cls: 'planner-template-item' });
          item.createEl('span', { text: `📄 ${name}`, cls: 'planner-template-item-label' });
          item.addEventListener('click', () => {
            void (async () => {
              try {
                const yaml = await loadCustomTemplate(this.app, name, this.settings.templatesFolder);
                this.onInsert(yaml);
                this.close();
              } catch (e) {
                new Notice(t('notice.loadError', { msg: e instanceof Error ? e.message : 'unknown' }));
              }
            })();
          });
        }
      }
    } catch {
      // No custom templates folder
    }

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText(t('btn.cancel'))
        .onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

class ImportCSVModal extends Modal {
  private settings: PlannerBoardsSettings;
  private onInsert: (yaml: string) => void;

  constructor(app: App, settings: PlannerBoardsSettings, onInsert: (yaml: string) => void) {
    super(app);
    this.settings = settings;
    this.onInsert = onInsert;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('modal.importCSV') });
    contentEl.createEl('p', { text: t('modal.importCSVHint') });

    const textarea = contentEl.createEl('textarea');
    textarea.addClass('planner-import-textarea');
    textarea.placeholder = t('ui.csvPlaceholder');

    let title = '';
    new Setting(contentEl)
      .setName(t('modal.plannerTitle'))
      .addText(text => text
        .setPlaceholder(t('modal.plannerTitlePlaceholder'))
        .onChange(val => { title = val; }));

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText(t('btn.import'))
        .setCta()
        .onClick(() => {
          const csv = textarea.value.trim();
          if (!csv) { new Notice(t('notice.pasteCSV')); return; }
          try {
            const yaml = csvToYaml(csv, title || t('modal.defaultPlannerTitle'), this.settings.defaultTheme);
            this.onInsert(yaml);
            this.close();
          } catch (e) {
            new Notice(t('notice.csvParseError', { msg: e instanceof Error ? e.message : 'unknown' }));
          }
        }))
      .addButton(btn => btn
        .setButtonText(t('btn.cancel'))
        .onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

function csvToYaml(csv: string, title: string, theme: string): string {
  const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 1) throw new Error(t('ui.csvEmpty'));

  const headers = parseCSVLine(lines[0]);
  const columns = headers.map((h, i) => {
    const id = `col_${i}`;
    const value = lines.length > 1 ? parseCSVLine(lines[1])[i] : '';
    const type = guessType(value);
    return `  - id: ${id}\n    label: "${h}"\n    type: ${type}`;
  });

  const dataRows = lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const entries = headers.map((_, i) => {
      const id = `col_${i}`;
      const val = values[i] || '';
      const num = Number(val);
      if (val === 'true' || val === 'false') return `    ${id}: ${val}`;
      if (!isNaN(num) && val !== '') return `    ${id}: ${num}`;
      return `    ${id}: "${val.replace(/"/g, '\\"')}"`;
    });
    return '  - ' + entries.join('\n').slice(4);
  });

  return `type: grid\ntitle: "${title}"\ntheme: ${theme}\n\ncolumns:\n${columns.join('\n')}\n\ndata:\n${dataRows.join('\n')}`;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

function guessType(value: string): string {
  if (!value) return 'text';
  if (value === 'true' || value === 'false') return 'checkbox';
  if (!isNaN(Number(value))) return 'number';
  return 'text';
}
