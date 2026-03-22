import { WorkspaceLeaf, setIcon, Notice, Menu, TextFileView, Modal, App, Setting, TFolder, TFile } from 'obsidian';
import type PlannerBoardsPlugin from './main';
import { createPlanner } from './engine/planner-engine';
import { parseSchema } from './parser/schema-parser';
import { serializeSchema } from './parser/data-serializer';
import { expandTemplate } from './templates/template-registry';
import { t, tArray } from './i18n';
import type { PlannerSchema } from './types';

export const VIEW_TYPE_BOARD = 'planner-board-view';
export const VIEW_TYPE_PLANNER_FILE = 'planner-file-view';

interface BoardConfig {
  folder: string;
  showCalendar: boolean;
  calendars: string[];
  templateFolders: Record<string, string>;
  dailyNotesFolder: string;
  dailyNoteFormat: string;
  dictionaries: Record<string, string[]>;
  templateDefaults: Record<string, string>;
}

interface PlannerBlock {
  file: string;
  title: string;
  yaml: string;
  originalYaml: string;
  month: string;  // "YYYY-MM", "YYYY" (year-only), or "none"
  day?: string;   // "YYYY-MM-DD" for daily planners
  template: string; // template key for category grouping
}

type NavLevel = 'root' | 'year' | 'month' | 'week' | 'day';

interface NavState {
  level: NavLevel;
  year?: number;
  month?: number;   // 1-12
  week?: number;    // ISO week 1-53
  day?: string;     // "YYYY-MM-DD"
}

const getMonthNames = () => tArray('months.full');
const getMonthShort = () => tArray('months.short');
const getDayNames = () => tArray('days.short');

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getWeeksInMonth(year: number, month: number): { week: number; start: Date; end: Date }[] {
  const weeks: { week: number; start: Date; end: Date }[] = [];
  const seen = new Set<number>();
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const w = getISOWeek(date);
    if (!seen.has(w)) {
      seen.add(w);
      // Find Monday of this ISO week
      const day = date.getDay() || 7;
      const monday = new Date(date);
      monday.setDate(date.getDate() - day + 1);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      weeks.push({ week: w, start: monday, end: sunday });
    }
  }
  return weeks;
}

function getDaysInWeek(year: number, week: number): { date: string; dayName: string; dayNum: number }[] {
  // Find Monday of ISO week
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  const days: { date: string; dayName: string; dayNum: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: iso, dayName: getDayNames()[d.getDay()], dayNum: d.getDate() });
  }
  return days;
}

function formatDailyNotePath(folder: string, format: string, dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const formatted = format.replace('YYYY', y).replace('MM', m).replace('DD', d);
  return `${folder}/${formatted}.md`;
}

/**
 * Board view — hierarchical Year → Month → Week → Day navigation.
 */
export class BoardView extends TextFileView {
  private plugin: PlannerBoardsPlugin;
  private config: BoardConfig = {
    folder: '', showCalendar: false, calendars: [],
    templateFolders: {}, dailyNotesFolder: 'Daily', dailyNoteFormat: 'YYYY-MM-DD',
    dictionaries: {}, templateDefaults: {},
  };
  private nav: NavState = { level: 'root' };
  private plannerBlocks: PlannerBlock[] = [];
  private contentArea: HTMLElement;
  private tabBar: HTMLElement;
  private headerEl: HTMLElement;
  private breadcrumbEl: HTMLElement;
  private suppressRefresh = false;
  private activeMode: 'planner' | 'finance' | 'goals' | 'projects' | 'reading' | 'settings' = 'planner';
  private settingsTab: 'general' | 'dictionaries' | 'templates' = 'general';

  constructor(leaf: WorkspaceLeaf, plugin: PlannerBoardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_BOARD; }
  getViewData(): string { return this.data; }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (this.suppressRefresh) { this.suppressRefresh = false; return; }
    this.parseBoardConfig();
    void this.refresh();
  }

  clear(): void { this.contentArea?.empty(); }
  getIcon(): string { return 'layout-grid'; }

  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('planner-board-root');
    this.headerEl = root.createDiv({ cls: 'planner-board-header' });
    this.breadcrumbEl = root.createDiv({ cls: 'planner-board-breadcrumb' });
    this.tabBar = root.createDiv({ cls: 'planner-board-tabs planner-board-tabs-top' });
    this.contentArea = root.createDiv({ cls: 'planner-board-content' });
  }

  private parseBoardConfig() {
    const fmMatch = this.data.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return;
    const fm = fmMatch[1];
    const get = (key: string) => {
      const m = fm.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)`));
      return m ? m[1].trim() : '';
    };
    const getBool = (key: string, def: boolean) => {
      const m = fm.match(new RegExp(`${key}:\\s*(true|false)`));
      return m ? m[1] === 'true' : def;
    };
    this.config.folder = get('folder') || (this.file?.parent?.path || '');
    this.config.showCalendar = getBool('show-calendar', false);
    this.config.dailyNotesFolder = get('daily-notes-folder') || 'Daily';
    this.config.dailyNoteFormat = get('daily-note-format') || 'YYYY-MM-DD';

    const calMatch = fm.match(/calendars:\s*\n((?:\s+-\s*.+\n?)*)/);
    if (calMatch) {
      this.config.calendars = calMatch[1].match(/- ["']?([^"'\n]+)/g)
        ?.map(s => s.replace(/^-\s*["']?/, '').replace(/["']$/, '').trim()) || [];
    } else {
      this.config.calendars = [];
    }
    this.config.templateFolders = {};
    const tfMatch = fm.match(/template-folders:\s*\n((?:\s+\S+:\s*.+\n?)*)/);
    if (tfMatch) {
      for (const line of tfMatch[1].split('\n')) {
        const kv = line.match(/^\s+(\S+):\s*["']?([^"'\n]+)/);
        if (kv) this.config.templateFolders[kv[1]] = kv[2].trim();
      }
    }
    // Parse dictionaries
    this.config.dictionaries = {};
    const dictMatch = fm.match(/dictionaries:\s*\n((?:\s+[\w-]+:\s*\n(?:\s+-\s*.+\n?)*)*)/);
    if (dictMatch) {
      const dictBlock = dictMatch[1];
      const dictEntries = dictBlock.match(/\s+([\w-]+):\s*\n((?:\s+-\s*.+\n?)*)/g);
      if (dictEntries) {
        for (const entry of dictEntries) {
          const nameMatch = entry.match(/\s+([\w-]+):\s*\n/);
          if (nameMatch) {
            const name = nameMatch[1];
            const items = entry.match(/-\s*["']?([^"'\n]+)/g)
              ?.map(s => s.replace(/^-\s*["']?/, '').replace(/["']$/, '').trim()) || [];
            this.config.dictionaries[name] = items;
          }
        }
      }
    }
    // Parse templateDefaults
    this.config.templateDefaults = {};
    const tdMatch = fm.match(/template-defaults:\s*\n((?:\s+[\w-]+:\s*\|[\s\S]*?)(?=\n\S|\n?$))/);
    if (tdMatch) {
      const tdBlock = tdMatch[1];
      const tdEntries = tdBlock.match(/\s+([\w-]+):\s*\|\n((?:\s{4,}.+\n?)*)/g);
      if (tdEntries) {
        for (const entry of tdEntries) {
          const nameMatch = entry.match(/\s+([\w-]+):\s*\|\n/);
          if (nameMatch) {
            const name = nameMatch[1];
            const yamlContent = entry.replace(/\s+[\w-]+:\s*\|\n/, '').replace(/^ {4}/gm, '').trimEnd();
            if (yamlContent) this.config.templateDefaults[name] = yamlContent;
          }
        }
      }
    }
    this.ensureDefaultDictionaries();
  }

  private getDefaultDictionaries(): Record<string, string[]> {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    return {
      'planner-categories': isRu
        ? ['Работа', 'Личное', 'Здоровье', 'Учёба', 'Другое']
        : ['Work', 'Personal', 'Health', 'Study', 'Other'],
      'planner-weekly-priorities': isRu
        ? ['🔴 Срочно / Важно', '🟡 Не срочно / Важно', '🟠 Срочно / Не важно', '🟢 Не срочно / Не важно']
        : ['🔴 Urgent / Important', '🟡 Not Urgent / Important', '🟠 Urgent / Not Important', '🟢 Not Urgent / Not Important'],
      'planner-daily-priorities': isRu
        ? ['🔴 Важно', '🟡 Средне', '🟢 Не важно']
        : ['🔴 Important', '🟡 Medium', '🟢 Not Important'],
      'finance-fixed-categories': isRu
        ? ['Аренда/Ипотека', 'Коммунальные', 'Зал', 'Интернет/Связь', 'Страховка', 'Налоги', 'Другое']
        : ['Rent/Mortgage', 'Utilities', 'Gym', 'Internet/Phone', 'Insurance', 'Taxes', 'Other'],
      'finance-variable-categories': isRu
        ? ['Продукты', 'Кафе/Рестораны', 'Медицина', 'Развлечения', 'Одежда', 'Путешествия', 'Бензин', 'Транспорт', 'Уход за собой', 'Подарки', 'Хобби', 'Другое']
        : ['Groceries', 'Dining', 'Medical', 'Entertainment', 'Clothing', 'Travel', 'Gas', 'Transport', 'Self-care', 'Gifts', 'Hobbies', 'Other'],
      'goal-statuses': isRu
        ? ['⬜ Не начато', '🔵 В процессе', '✅ Достигнуто', '❌ Отменено']
        : ['⬜ Not started', '🔵 In progress', '✅ Achieved', '❌ Cancelled'],
      'project-statuses': isRu
        ? ['⬜ Ожидает', '🔵 В работе', '🟡 Ревью', '✅ Готово']
        : ['⬜ Pending', '🔵 In Progress', '🟡 Review', '✅ Done'],
      'project-priorities': isRu
        ? ['🔴 Высокий', '🟠 Средний', '🟢 Низкий']
        : ['🔴 High', '🟠 Medium', '🟢 Low'],
      'reading-statuses': isRu
        ? ['📖 Читаю', '⏸️ Пауза', '✅ Прочитано', '📋 В очереди']
        : ['📖 Reading', '⏸️ Paused', '✅ Finished', '📋 To Read'],
    };
  }

  private ensureDefaultDictionaries() {
    const defaults = this.getDefaultDictionaries();
    for (const [key, values] of Object.entries(defaults)) {
      if (!this.config.dictionaries[key] || this.config.dictionaries[key].length === 0) {
        this.config.dictionaries[key] = values;
      }
    }
  }

  private serializeConfig(): string {
    let fm = '---\n';
    fm += 'planner-board: true\n';
    fm += `folder: "${this.config.folder}"\n`;
    fm += `show-calendar: ${this.config.showCalendar}\n`;
    fm += `daily-notes-folder: "${this.config.dailyNotesFolder}"\n`;
    fm += `daily-note-format: "${this.config.dailyNoteFormat}"\n`;
    if (this.config.calendars.length > 0) {
      fm += 'calendars:\n';
      for (const c of this.config.calendars) fm += `  - "${c}"\n`;
    }
    const tf = this.config.templateFolders;
    if (Object.keys(tf).length > 0) {
      fm += 'template-folders:\n';
      for (const [key, val] of Object.entries(tf)) fm += `  ${key}: "${val}"\n`;
    }
    const dict = this.config.dictionaries;
    if (Object.keys(dict).length > 0) {
      fm += 'dictionaries:\n';
      for (const [key, values] of Object.entries(dict)) {
        fm += `  ${key}:\n`;
        for (const v of values) fm += `    - "${v}"\n`;
      }
    }
    const td = this.config.templateDefaults;
    if (Object.keys(td).length > 0) {
      fm += 'template-defaults:\n';
      for (const [key, yaml] of Object.entries(td)) {
        fm += `  ${key}: |\n`;
        for (const line of yaml.split('\n')) fm += `    ${line}\n`;
      }
    }
    fm += '---\n';
    return fm;
  }

  private saveConfig() { this.data = this.serializeConfig(); this.requestSave(); }
  getBoardConfig(): BoardConfig { return { ...this.config }; }

  private async refresh() {
    if (!this.headerEl) return;
    await this.scanPlanners();
    this.buildHeader();
    this.buildBreadcrumb();
    this.buildTabs();
    this.renderContent();
  }

  private async scanPlanners() {
    this.plannerBlocks = [];
    const folder = this.app.vault.getAbstractFileByPath(this.config.folder);
    if (!folder) return;
    const files = this.app.vault.getFiles().filter(f =>
      (f.path.startsWith(this.config.folder + '/') || f.path === this.config.folder) &&
      f.path !== this.file?.path && (f.extension === 'md' || f.extension === 'planner')
    );
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const regex = /```planner\n([\s\S]*?)```/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          const rawYaml = match[1]; // keep raw for accurate replacement
          const yaml = rawYaml.trim();
          const titleMatch = yaml.match(/title:\s*["']?([^"'\n]+)/);
          const templateMatch = yaml.match(/template:\s*(\S+)/);
          const monthMatch = yaml.match(/month:\s*["']?(\d{4}-\d{2})/);
          const yearMatch = yaml.match(/year:\s*["']?(\d{4})/);
          const weekMatch = yaml.match(/week:\s*["']?(\d{4})-W(\d{2})/);
          const dayMatch = yaml.match(/day:\s*["']?(\d{4}-\d{2}-\d{2})/);
          let title = titleMatch?.[1] || '';
          if (!title && templateMatch) {
            const tmplKey = templateMatch[1];
            if (tmplKey === 'daily-planner' && dayMatch) {
              const isRu = this.plugin.settings.uiLanguage !== 'en';
              title = `📅 ${isRu ? 'Ежедневник' : 'Daily planner'} — ${dayMatch[1]}`;
            } else {
              title = t(`tmpl.${tmplKey}`) || tmplKey;
            }
          }
          if (!title) title = t('board.defaultPlannerTitle');
          let month = 'none';
          let day: string | undefined;
          if (dayMatch) {
            day = dayMatch[1];
            month = day.substring(0, 7); // "YYYY-MM" from "YYYY-MM-DD"
          } else if (monthMatch) {
            month = monthMatch[1];
          } else if (weekMatch) {
            const jan4 = new Date(parseInt(weekMatch[1]), 0, 4);
            const weekStart = new Date(jan4);
            weekStart.setDate(jan4.getDate() - jan4.getDay() + 1 + (parseInt(weekMatch[2]) - 1) * 7);
            month = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}`;
          } else if (yearMatch) {
            month = yearMatch[1];
          }
          const templateKey = templateMatch?.[1] || 'custom';
          this.plannerBlocks.push({ file: file.path, title, yaml, originalYaml: rawYaml, month, day, template: templateKey });
        }
      } catch { /* skip */ }
    }
  }

  private navigate(state: NavState) {
    this.nav = state;
    this.buildBreadcrumb();
    this.buildTabs();
    this.renderContent();
  }

  /** Navigate to a specific day — can be called externally from hub */
  navigateToDay(dateStr: string) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const week = getISOWeek(d);
    this.navigate({ level: 'day', year, month, week, day: dateStr });
  }

  private getFilteredBlocks(): PlannerBlock[] {
    const { level, year, month, day } = this.nav;
    let blocks: PlannerBlock[];
    if (level === 'root') blocks = this.plannerBlocks;
    else if (level === 'year' && year) {
      blocks = this.plannerBlocks.filter(b => b.month.startsWith(String(year)));
    } else if ((level === 'month' || level === 'week' || level === 'day') && year && month) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      blocks = this.plannerBlocks.filter(b => b.month === key);
    } else {
      blocks = this.plannerBlocks;
    }

    // Daily planners with day: field only show at day level with matching date
    blocks = blocks.filter(b => {
      if (b.day) {
        return level === 'day' && day === b.day;
      }
      return true;
    });
    // In planner mode, exclude blocks that belong to separate modes
    blocks = blocks.filter(b => !BoardView.SEPARATE_MODE_TEMPLATES.includes(b.template));
    return blocks;
  }

  private getYears(): number[] {
    const years = new Set<number>();
    for (const b of this.plannerBlocks) {
      if (b.month === 'none') continue;
      const y = parseInt(b.month.substring(0, 4));
      if (!isNaN(y)) years.add(y);
    }
    return Array.from(years).sort();
  }

  private getMonthsForYear(year: number): number[] {
    const months = new Set<number>();
    const prefix = String(year);
    for (const b of this.plannerBlocks) {
      if (b.month.startsWith(prefix + '-')) {
        const m = parseInt(b.month.split('-')[1]);
        if (!isNaN(m)) months.add(m);
      }
    }
    return Array.from(months).sort((a, b) => a - b);
  }

  private buildHeader() {
    this.headerEl.empty();
    const titleRow = this.headerEl.createDiv({ cls: 'planner-board-title-row' });
    const boardName = this.file?.basename || 'Planner Board';
    const titleEl = titleRow.createDiv({ cls: 'planner-board-title-info' });
    titleEl.createEl('h2', { text: `📋 ${boardName}`, cls: 'planner-board-title' });
    titleEl.createEl('span', { text: `📁 ${this.config.folder}`, cls: 'planner-board-folder-label' });

    // Mode switcher (Planner / Finance)
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modeSwitcher = titleRow.createDiv({ cls: 'planner-mode-switcher' });
    const modes: { id: 'planner' | 'finance' | 'goals' | 'projects' | 'reading'; label: string }[] = [
      { id: 'planner', label: `📅 ${isRu ? 'Планер' : 'Planner'}` },
      { id: 'finance', label: `💰 ${isRu ? 'Финансы' : 'Finance'}` },
      { id: 'goals', label: `🎯 ${isRu ? 'Цели' : 'Goals'}` },
      { id: 'projects', label: `🚀 ${isRu ? 'Проекты' : 'Projects'}` },
      { id: 'reading', label: `📖 ${isRu ? 'Чтение' : 'Reading'}` },
    ];
    for (const mode of modes) {
      const btn = modeSwitcher.createEl('button', {
        text: mode.label,
        cls: `planner-mode-btn ${this.activeMode === mode.id ? 'planner-mode-btn-active' : ''}`,
      });
      btn.addEventListener('click', () => {
        if (this.activeMode !== mode.id) {
          this.activeMode = mode.id;
          this.buildHeader();
          this.buildBreadcrumb();
          this.buildTabs();
          this.renderContent();
        }
      });
    }

    const actions = titleRow.createDiv({ cls: 'planner-board-actions' });
    if (this.config.showCalendar) {
      const syncBtn = actions.createEl('button', { cls: 'planner-view-action-btn', title: t('btn.sync') });
      setIcon(syncBtn, 'refresh-cw');
      syncBtn.addEventListener('click', () => {
        void this.plugin.syncCalendars().then(() => {
          new Notice(t('notice.synced'));
          this.renderContent();
        });
      });
    }
    const settingsBtn = actions.createEl('button', { cls: `planner-view-action-btn ${this.activeMode === 'settings' ? 'planner-view-action-btn-active' : ''}`, title: t('board.settingsTooltip') });
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      if (this.activeMode !== 'settings') {
        this.activeMode = 'settings';
        this.buildHeader();
        this.buildBreadcrumb();
        this.buildTabs();
        this.renderContent();
      }
    });
    const refreshBtn = actions.createEl('button', { cls: 'planner-view-action-btn', title: t('ui.refresh') });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => void this.refresh());
  }

  private buildBreadcrumb() {
    this.breadcrumbEl.empty();
    if (this.activeMode === 'settings') return;
    const { level, year, month, week, day } = this.nav;
    const add = (text: string, onClick?: () => void) => {
      if (this.breadcrumbEl.childElementCount > 0)
        this.breadcrumbEl.createSpan({ text: ' ▸ ', cls: 'planner-breadcrumb-sep' });
      const s = this.breadcrumbEl.createEl('span', { text, cls: 'planner-breadcrumb-item' });
      if (onClick) { s.addClass('planner-breadcrumb-link'); s.addEventListener('click', onClick); }
      else s.addClass('planner-breadcrumb-current');
    };
    add(level === 'root' ? t('ui.all') : t('ui.all'), level !== 'root' ? () => this.navigate({ level: 'root' }) : undefined);
    if (!year) return;
    add(`📅 ${year}`, level !== 'year' ? () => this.navigate({ level: 'year', year }) : undefined);
    if (!month) return;
    add(getMonthNames()[month - 1], level !== 'month' ? () => this.navigate({ level: 'month', year, month }) : undefined);
    if (!week) return;
    const wDays = getDaysInWeek(year, week);
    const wStart = new Date(wDays[0].date);
    const wEnd = new Date(wDays[6].date);
    const wLabel = `${wStart.getDate()} ${getMonthShort()[wStart.getMonth()]} — ${wEnd.getDate()} ${getMonthShort()[wEnd.getMonth()]}`;
    add(wLabel, level !== 'week' ? () => this.navigate({ level: 'week', year, month, week }) : undefined);
    if (!day) return;
    const dd = new Date(day);
    add(`${dd.getDate()} ${getDayNames()[dd.getDay()]}`);
  }

  private buildTabs() {
    this.tabBar.empty();
    if (this.activeMode === 'settings') return;
    const { level, year, month, week } = this.nav;

    // Goals, Projects, Reading modes: Year → Quarter/Month navigation
    if (this.activeMode === 'goals' || this.activeMode === 'projects' || this.activeMode === 'reading') {
      if (level === 'root') {
        const years = this.getYears();
        for (const y of years) {
          const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab planner-board-tab-year' });
          tab.textContent = `📅 ${y}`;
          tab.addEventListener('click', () => this.navigate({ level: 'year', year: y }));
        }
      } else if (level === 'year' && year) {
        if (this.activeMode === 'goals') {
          // Quarters for goals
          for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
            const qNum = parseInt(q[1]);
            const firstMonth = (qNum - 1) * 3 + 1;
            const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab' });
            tab.textContent = q;
            tab.addEventListener('click', () => this.navigate({ level: 'month', year, month: firstMonth }));
          }
        } else {
          // Months for projects/reading
          const months = getMonthShort();
          for (let m = 1; m <= 12; m++) {
            const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab' });
            tab.textContent = months[m - 1];
            tab.addEventListener('click', () => this.navigate({ level: 'month', year, month: m }));
          }
        }
      }
      // No deeper navigation for these modes
      return;
    }

    if (level === 'root') {
      const years = this.getYears();
      for (const y of years) {
        const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab planner-board-tab-year' });
        tab.textContent = `📅 ${y}`;
        const count = this.plannerBlocks.filter(b => b.month.startsWith(String(y))).length;
        if (count > 0) tab.createEl('span', { text: ` (${count})`, cls: 'planner-board-tab-count' });
        tab.addEventListener('click', () => this.navigate({ level: 'year', year: y }));
      }
      const hasNone = this.plannerBlocks.some(b => b.month === 'none');
      if (hasNone) {
        const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab' });
        tab.textContent = t('ui.noDate');
        const count = this.plannerBlocks.filter(b => b.month === 'none').length;
        if (count > 0) tab.createEl('span', { text: ` (${count})`, cls: 'planner-board-tab-count' });
        tab.addEventListener('click', () => this.navigate({ level: 'root' }));
      }
    } else if (level === 'year' && year) {
      const months = this.getMonthsForYear(year);
      for (const m of months) {
        const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab' });
        tab.textContent = getMonthShort()[m - 1];
        tab.addEventListener('click', () => this.navigate({ level: 'month', year, month: m }));
      }
      const addTab = this.tabBar.createEl('button', { cls: 'planner-board-tab planner-board-tab-add', title: t('ui.newMonth') });
      addTab.textContent = '+';
      addTab.addEventListener('click', (evt) => this.showAddMonthMenu(evt));
    } else if (level === 'month' && year && month) {
      const weeks = getWeeksInMonth(year, month);
      for (const w of weeks) {
        const tab = this.tabBar.createEl('button', { cls: 'planner-board-tab' });
        const wStart = w.start;
        const wEnd = w.end;
        tab.textContent = `${wStart.getDate()} ${getMonthShort()[wStart.getMonth()]} — ${wEnd.getDate()} ${getMonthShort()[wEnd.getMonth()]}`;
        tab.addEventListener('click', () => this.navigate({ level: 'week', year, month, week: w.week }));
      }
    } else if (level === 'week' && year && week) {
      const days = getDaysInWeek(year, week);
      const existingDays = new Set(this.plannerBlocks.filter(b => b.day).map(b => b.day));
      for (const d of days) {
        const cls = existingDays.has(d.date) ? 'planner-board-tab has-planner' : 'planner-board-tab';
        const tab = this.tabBar.createEl('button', { cls });
        tab.textContent = `${d.dayName} ${d.dayNum}`;
        tab.addEventListener('click', () => this.navigate({ level: 'day', year, month, week, day: d.date }));
      }
    }
    // day level: no child tabs
  }

  private renderContent() {
    this.contentArea.empty();
    const { level } = this.nav;

    // ── Settings mode ──
    if (this.activeMode === 'settings') {
      this.renderSettingsPage();
      return;
    }

    // ── Finance mode: separate Year→Month→Week→Day for finances ──
    if (this.activeMode === 'finance') {
      this.renderFinanceContent();
      return;
    }

    // ── Goals mode: Year level only ──
    if (this.activeMode === 'goals') {
      this.renderGoalsContent();
      return;
    }

    // ── Projects mode: Year level only ──
    if (this.activeMode === 'projects') {
      this.renderProjectsContent();
      return;
    }

    // ── Reading mode: Year level only ──
    if (this.activeMode === 'reading') {
      this.renderReadingContent();
      return;
    }

    // ── Planner mode (original) ──
    // Daily note section at day level
    if (level === 'day' && this.nav.day) {
      this.renderDailyNoteSection(this.nav.day);
    }

    // Dynamic aggregated summaries from daily planners
    if (level === 'year' && this.nav.year) {
      this.renderYearlySummary();
    } else if (level === 'month' && this.nav.year && this.nav.month) {
      this.renderMonthlySummary();
    } else if (level === 'week' && this.nav.year && this.nav.week) {
      this.renderWeeklySummary();
    }

    // Calendar section
    if (this.config.showCalendar && this.plugin.calendarSync) {
      this.renderCalendarSection();
    }

    // Planners
    const blocks = this.getFilteredBlocks();

    // At day level: show create daily planner button if none exists
    if (level === 'day' && this.nav.day) {
      const hasDailyPlanner = blocks.some(b => b.template === 'daily-planner' && b.day === this.nav.day);
      if (!hasDailyPlanner) {
        const createSection = this.contentArea.createDiv({ cls: 'planner-board-create-daily' });
        const createBtn = createSection.createEl('button', {
          text: t('board.createDailyPlanner'),
          cls: 'mod-cta',
        });
        createBtn.addEventListener('click', () => {
          void this.addPlannerToBoard('daily-planner');
        });
      }
    }

    if (blocks.length === 0 && !this.config.showCalendar && level !== 'day') {
      return;
    }

    for (const block of blocks) {
      const card = this.contentArea.createDiv({ cls: 'planner-view-card' });
      const cardHeader = card.createDiv({ cls: 'planner-view-card-header' });
      cardHeader.createEl('h3', { text: block.title });
      const cardActions = cardHeader.createDiv({ cls: 'planner-view-card-actions' });
      const fileLink = cardActions.createEl('a', {
        text: block.file.replace(this.config.folder + '/', ''),
        cls: 'planner-view-card-file',
      });
      fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(block.file, '');
      });
      const cardBody = card.createDiv({ cls: 'planner-view-card-body planner-boards-root' });
      createPlanner(block.yaml, cardBody, {
        suppressTitle: true,
        onAddItem: block.template === 'daily-planner' && block.day ? (subtableTitle: string) => {
          const type = this.resolveSubtableType(subtableTitle);
          if (!type) return;
          if (type === 'notes') {
            this.addNoteModal(block);
            return;
          }
          if (type === 'mood') {
            this.addMoodModal(block);
            return;
          }
          if (type === 'exercise') {
            this.addExerciseModal(block);
            return;
          }
          const date = new Date(block.day! + 'T00:00:00');
          const year = date.getFullYear();
          const week = getISOWeek(date);
          const days = getDaysInWeek(year, week);
          this.addWeeklyItem(type, week, year, days);
        } : undefined,
        onDataChange: async (newYaml: string) => {
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
            // Sync habits across daily planners in the same week
            if (block.template === 'daily-planner' && block.day) {
              await this.syncWeeklyData(block.day);
              await this.syncMonthlyData(block.day);
            }
          }
        },
      });
    }
  }

  private renderMiniCalendar() {
    const year = this.nav.year!;
    const month = this.nav.month!;
    const section = this.contentArea.createDiv({ cls: 'planner-board-mini-calendar' });
    section.createEl('h4', { text: `📅 ${getMonthNames()[month - 1]} ${year}` });

    // Collect days that have daily planners
    const daysWithPlanners = new Set<string>();
    for (const b of this.plannerBlocks) {
      if (b.day && b.day.startsWith(`${year}-${String(month).padStart(2, '0')}`)) {
        daysWithPlanners.add(b.day);
      }
    }

    const dayHeaders = getDayNames();
    const grid = section.createDiv({ cls: 'planner-mini-cal-grid' });
    // Header row: Пн Вт Ср Чт Пт Сб Вс
    for (let i = 1; i <= 7; i++) {
      grid.createDiv({ cls: 'planner-mini-cal-header', text: dayHeaders[i % 7] });
    }

    const firstDay = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    // Monday=0 offset
    let startOffset = (firstDay.getDay() + 6) % 7;
    for (let i = 0; i < startOffset; i++) {
      grid.createDiv({ cls: 'planner-mini-cal-empty' });
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const cell = grid.createDiv({ cls: 'planner-mini-cal-day' });
      cell.textContent = String(d);
      if (daysWithPlanners.has(dateStr)) {
        cell.addClass('has-planner');
        cell.title = t('board.hasDailyPlanner');
      }
      if (dateStr === todayStr) {
        cell.addClass('is-today');
      }
      cell.addEventListener('click', () => {
        const dt = new Date(year, month - 1, d);
        const week = getISOWeek(dt);
        this.navigate({ level: 'day', year, month, week, day: dateStr });
      });
    }
  }

  private renderDailyNoteSection(dateStr: string) {
    const section = this.contentArea.createDiv({ cls: 'planner-board-daily-section' });
    section.createEl('h3', { text: t('board.dailyNote', { date: dateStr }) });
    const path = formatDailyNotePath(this.config.dailyNotesFolder, this.config.dailyNoteFormat, dateStr);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const btnRow = section.createDiv({ cls: 'planner-board-daily-buttons' });
    if (existing) {
      const openBtn = btnRow.createEl('button', { text: t('btn.openNote'), cls: 'mod-cta' });
      openBtn.addEventListener('click', () => void this.app.workspace.openLinkText(path, ''));
    } else {
      const createBtn = btnRow.createEl('button', { text: t('btn.createNote'), cls: 'mod-cta' });
      createBtn.addEventListener('click', () => {
        void (async () => {
          const parts = path.split('/');
          let dir = '';
          for (let i = 0; i < parts.length - 1; i++) {
            dir = dir ? `${dir}/${parts[i]}` : parts[i];
            if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
          }
          await this.app.vault.create(path, `# ${dateStr}\n\n`);
          new Notice(t('notice.noteCreated', { path }));
          void this.app.workspace.openLinkText(path, '');
        })();
      });
    }
  }

  private renderCalendarSection() {
    const section = this.contentArea.createDiv({ cls: 'planner-board-cal-section' });
    section.createEl('h3', { text: t('board.calendarEvents') });
    const boundSources = this.plugin.settings.calendar.sources.filter(s =>
      s.enabled && (this.config.calendars.length === 0 || this.config.calendars.includes(s.id))
    );
    if (boundSources.length === 0) {
      section.createEl('p', { text: t('board.noCalendarsLinked'), cls: 'planner-view-no-events' });
      return;
    }
    const now = new Date();
    const allEvents = this.plugin.calendarSync?.getEventsForDay(now) || [];
    const events = allEvents.filter(ev =>
      this.config.calendars.length === 0 || this.config.calendars.includes(ev.sourceId)
    );
    if (events.length === 0) {
      section.createEl('p', { text: t('board.noEventsToday'), cls: 'planner-view-no-events' });
    } else {
      const list = section.createDiv({ cls: 'planner-view-event-list' });
      for (const ev of events) {
        const item = list.createDiv({ cls: 'planner-view-event-item' });
        item.style.setProperty('--event-color', ev.color);
        const time = item.createEl('span', { cls: 'planner-view-event-item-time' });
        if (ev.allDay) { time.textContent = t('ui.allDay'); }
        else {
          const h = String(ev.start.getHours()).padStart(2, '0');
          const m = String(ev.start.getMinutes()).padStart(2, '0');
          time.textContent = `${h}:${m}`;
        }
        item.createEl('span', { text: ev.summary, cls: 'planner-view-event-item-title' });
      }
    }
    const legend = section.createDiv({ cls: 'planner-view-cal-legend' });
    for (const source of boundSources) {
      const item = legend.createDiv({ cls: 'planner-view-legend-item' });
      const dot = item.createEl('span', { cls: 'planner-view-legend-dot' });
      dot.style.setProperty('--dot-color', source.color);
      item.createEl('span', { text: source.name });
    }
  }

  // Templates that belong to their own separate modes (not shown in planner mode)
  private static readonly SEPARATE_MODE_TEMPLATES: string[] = ['goal-tracker', 'project-tracker', 'reading-log', 'finance-planner', 'daily-finance'];

  /** Get daily planner blocks for a date range (inclusive) */
  private getDailyBlocksForRange(startDate: string, endDate: string): PlannerBlock[] {
    return this.plannerBlocks.filter(b =>
      b.template === 'daily-planner' && b.day && b.day >= startDate && b.day <= endDate
    );
  }

  /** Sync habits and weekly tasks across all daily planners in the same week */
  private async syncWeeklyData(changedDay: string) {
    const date = new Date(changedDay);
    const week = getISOWeek(date);
    const year = date.getFullYear();
    const days = getDaysInWeek(year, week);
    const startDate = days[0].date;
    const endDate = days[6].date;
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    if (dailyBlocks.length < 2) return;

    // Collect all habits, weekly tasks, and daily tasks from all dailies
    const allHabitNames = new Set<string>();
    const blockHabits = new Map<string, { habit: string; description: string; done: boolean }[]>();
    const allWeeklyTasks = new Map<string, { task: string; priority: string; category: string }>();
    const blockWeeklyTasks = new Map<string, { task: string; priority: string; done: boolean; completedDate: string }[]>();
    const allDailyTaskNames = new Set<string>();
    const dailyTaskInfo = new Map<string, { priority: string; category: string }>();

    for (const block of dailyBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const sections = (expanded as PlannerSchema).sections;
        if (sections?.habits) {
          const habits = sections.habits as Record<string, string | number | boolean>[];
          blockHabits.set(block.day!, habits);
          for (const h of habits) {
            if (h.habit) allHabitNames.add(h.habit);
          }
        }
        if (sections?.weeklyTasks) {
          const wTasks = sections.weeklyTasks as Record<string, string | number | boolean>[];
          blockWeeklyTasks.set(block.day!, wTasks);
          for (const t of wTasks) {
            if (t.task && !allWeeklyTasks.has(t.task)) {
              allWeeklyTasks.set(t.task, {
                task: t.task,
                priority: t.priority || '',
                category: t.category || '',
              });
            }
          }
        }
        if (sections?.tasks) {
          for (const t of sections.tasks as Record<string, string | number | boolean>[]) {
            if (t.task && !allDailyTaskNames.has(t.task)) {
              allDailyTaskNames.add(t.task);
              dailyTaskInfo.set(t.task, { priority: t.priority || '', category: t.category || '' });
            }
          }
        }
      } catch { /* skip */ }
    }

    if (allHabitNames.size === 0 && allWeeklyTasks.size === 0 && allDailyTaskNames.size === 0) return;

    const descMap = new Map<string, string>();
    for (const [, hList] of blockHabits) {
      for (const h of hList) {
        if (h.habit && h.description && !descMap.has(h.habit)) {
          descMap.set(h.habit, h.description);
        }
      }
    }

    for (const block of dailyBlocks) {
      let needsUpdate = false;
      try {
        const schema = parseSchema(block.yaml);
        if (!schema.sections) (schema as PlannerSchema).sections = {};
        const sections = (schema as PlannerSchema).sections;

        // --- Sync habits ---
        if (allHabitNames.size > 0) {
          if (!sections.habits) sections.habits = [];
          const existingHabits = new Set((sections.habits as Record<string, string | number | boolean>[]).map((h: Record<string, string | number | boolean>) => h.habit).filter(Boolean));
          for (const name of allHabitNames) {
            if (!existingHabits.has(name)) {
              sections.habits = sections.habits.filter((h: Record<string, string | number | boolean>) => h.habit);
              sections.habits.push({ habit: name, description: descMap.get(name) || '', done: false });
              needsUpdate = true;
            }
          }
          if (needsUpdate) {
            sections.habits = sections.habits.filter((h: Record<string, string | number | boolean>) => h.habit);
            sections.habits.push({ habit: '', description: '', done: false });
          }
        }

        // --- Sync weekly tasks ---
        if (allWeeklyTasks.size > 0) {
          if (!sections.weeklyTasks) sections.weeklyTasks = [];
          const existingTasks = new Map<string, Record<string, string | number | boolean>>();
          for (const t of sections.weeklyTasks as Record<string, string | number | boolean>[]) {
            if (t.task) existingTasks.set(t.task, t);
          }
          for (const [taskName, masterTask] of allWeeklyTasks) {
            const existing = existingTasks.get(taskName);
            if (!existing) {
              // Add missing task (with done=false, each planner tracks its own completion)
              sections.weeklyTasks = sections.weeklyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
              sections.weeklyTasks.push({ done: false, task: masterTask.task, priority: masterTask.priority, category: masterTask.category, completedDate: '' });
              needsUpdate = true;
            }
          }
          if (needsUpdate) {
            sections.weeklyTasks = sections.weeklyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.weeklyTasks.push({ done: false, task: '', priority: '', category: '', completedDate: '' });
          }
        }

        // --- Sync daily tasks ---
        if (allDailyTaskNames.size > 0) {
          if (!sections.tasks) sections.tasks = [];
          const existingTasks = new Set((sections.tasks as Record<string, string | number | boolean>[]).map((t: Record<string, string | number | boolean>) => t.task).filter(Boolean));
          for (const taskName of allDailyTaskNames) {
            if (!existingTasks.has(taskName)) {
              sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
              const info = dailyTaskInfo.get(taskName)!;
              sections.tasks.push({ done: false, task: taskName, priority: info.priority, category: info.category });
              needsUpdate = true;
            }
          }
          if (needsUpdate) {
            sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.tasks.push({ done: false, task: '', priority: '', category: '' });
          }
        }

        if (!needsUpdate) continue;

        const newYaml = serializeSchema(schema);
        const file = this.app.vault.getAbstractFileByPath(block.file);
        if (!file) continue;
        const content = await this.app.vault.read(file as TFile);
        const searchStr = '```planner\n' + block.originalYaml + '```';
        const replaceStr = '```planner\n' + newYaml + '\n```';
        const newContent = content.replace(searchStr, replaceStr);
        if (newContent !== content) {
          await this.app.vault.modify(file as TFile, newContent);
          block.originalYaml = newYaml + '\n';
          block.yaml = newYaml;
        }
      } catch { /* skip */ }
    }
  }

  /** Sync monthly tasks across all daily planners in the same month */
  private async syncMonthlyData(changedDay: string) {
    const monthStr = changedDay.substring(0, 7); // "YYYY-MM"
    const [yearStr, monthNumStr] = monthStr.split('-');
    const year = parseInt(yearStr);
    const monthNum = parseInt(monthNumStr);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-${String(daysInMonth).padStart(2, '0')}`;
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    if (dailyBlocks.length < 2) return;

    const allMonthlyTasks = new Map<string, { task: string; priority: string; category: string }>();
    for (const block of dailyBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const sections = (expanded as PlannerSchema).sections;
        if (sections?.monthlyTasks) {
          for (const t of sections.monthlyTasks as Record<string, string | number | boolean>[]) {
            if (t.task && !allMonthlyTasks.has(t.task)) {
              allMonthlyTasks.set(t.task, { task: t.task, priority: t.priority || '', category: t.category || '' });
            }
          }
        }
      } catch { /* skip */ }
    }
    if (allMonthlyTasks.size === 0) return;

    for (const block of dailyBlocks) {
      let needsUpdate = false;
      try {
        const schema = parseSchema(block.yaml);
        if (!schema.sections) (schema as PlannerSchema).sections = {};
        const sections = (schema as PlannerSchema).sections;
        if (!sections.monthlyTasks) sections.monthlyTasks = [];
        const existing = new Set((sections.monthlyTasks as Record<string, string | number | boolean>[]).map((t: Record<string, string | number | boolean>) => t.task).filter(Boolean));
        for (const [taskName, master] of allMonthlyTasks) {
          if (!existing.has(taskName)) {
            sections.monthlyTasks = sections.monthlyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.monthlyTasks.push({ done: false, task: master.task, priority: master.priority, category: master.category, completedDate: '' });
            needsUpdate = true;
          }
        }
        if (needsUpdate) {
          sections.monthlyTasks = sections.monthlyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
          sections.monthlyTasks.push({ done: false, task: '', priority: '', category: '', completedDate: '' });
        }
        if (!needsUpdate) continue;
        const newYaml = serializeSchema(schema);
        const file = this.app.vault.getAbstractFileByPath(block.file);
        if (!file) continue;
        const content = await this.app.vault.read(file as TFile);
        const searchStr = '```planner\n' + block.originalYaml + '```';
        const replaceStr = '```planner\n' + newYaml + '\n```';
        const newContent = content.replace(searchStr, replaceStr);
        if (newContent !== content) {
          await this.app.vault.modify(file as TFile, newContent);
          block.originalYaml = newYaml + '\n';
          block.yaml = newYaml;
        }
      } catch { /* skip */ }
    }
  }

  /** Parse a daily planner block into structured data */
  private parseDailyData(block: PlannerBlock): {
    day: string;
    tasks: { done: boolean; task: string; category: string; priority: string }[];
    weeklyTasks: { done: boolean; task: string; priority: string; category: string; goal: string; completedDate: string }[];
    monthlyTasks: { done: boolean; task: string; priority: string; category: string; goal: string; completedDate: string }[];
    habits: { habit: string; done: boolean }[];
    mood: { metric: string; value: number }[];
    exercise: { exercise: string; value: number; unit: string }[];
    schedule: { time: string; task: string }[];
    fullSchedule: { time: string; task: string }[];
    scheduleItems: number;
  } {
    const result: { day: string; tasks: { done: boolean; task: string; category: string; priority: string }[]; weeklyTasks: { done: boolean; task: string; priority: string; category: string; goal: string; completedDate: string }[]; monthlyTasks: { done: boolean; task: string; priority: string; category: string; goal: string; completedDate: string }[]; habits: { habit: string; done: boolean }[]; mood: { metric: string; value: number }[]; exercise: { exercise: string; value: number; unit: string }[]; schedule: { time: string; task: string }[]; fullSchedule: { time: string; task: string }[]; scheduleItems: number } = { day: block.day!, tasks: [], weeklyTasks: [], monthlyTasks: [], habits: [], mood: [], exercise: [], schedule: [], fullSchedule: [], scheduleItems: 0 };
    try {
      const schema = parseSchema(block.yaml);
      const expanded = schema.template ? expandTemplate(schema) : schema;
      const sections = (expanded as PlannerSchema).sections;
      // Use sections directly for weekly tasks (more reliable than subtable column detection)
      if (sections?.weeklyTasks) {
        for (const t of sections.weeklyTasks as Record<string, string | number | boolean>[]) {
          if (t.task) {
            result.weeklyTasks.push({
              done: t.done === true, task: t.task,
              priority: t.priority || '', category: t.category || '', goal: t.goal || '', completedDate: t.completedDate || '',
            });
          }
        }
      }
      if (sections?.monthlyTasks) {
        for (const t of sections.monthlyTasks as Record<string, string | number | boolean>[]) {
          if (t.task) {
            result.monthlyTasks.push({
              done: t.done === true, task: t.task,
              priority: t.priority || '', category: t.category || '', goal: t.goal || '', completedDate: t.completedDate || '',
            });
          }
        }
      }
      if (sections?.mood) {
        for (const m of sections.mood as Record<string, string | number | boolean>[]) {
          if (m.metric && m.value) result.mood.push({ metric: m.metric, value: Number(m.value) || 0 });
        }
      }
      if (sections?.exercise) {
        for (const e of sections.exercise as Record<string, string | number | boolean>[]) {
          if (e.exercise && e.value) result.exercise.push({ exercise: e.exercise, value: Number(e.value) || 0, unit: e.unit || '' });
        }
      }
      const subtables = (expanded as PlannerSchema)._subtables;
      if (!subtables) return result;
      for (const sub of subtables) {
        const colIds = sub.columns.map((c) => c.id);
        if (colIds.includes('done') && colIds.includes('task') && colIds.includes('category') && !colIds.includes('completedDate')) {
          for (const row of sub.data) {
            if (row.task) {
              result.tasks.push({
                done: row.done === true, task: row.task,
                category: row.category || '', priority: row.priority || '',
              });
            }
          }
        } else if (colIds.includes('habit') && colIds.includes('done')) {
          for (const row of sub.data) {
            if (row.habit) {
              result.habits.push({ habit: row.habit, done: row.done === true });
            }
          }
        } else if (colIds.includes('time') && colIds.includes('task')) {
          for (const row of sub.data) {
            // task may be pipe-separated (multi-select)
            const taskStr = row.task || '';
            const tasks = taskStr.split('|').map((s: string) => s.trim()).filter(Boolean);
            result.fullSchedule.push({ time: row.time || '', task: tasks.join(', ') });
            if (tasks.length > 0) {
              result.schedule.push({ time: row.time || '', task: tasks.join(', ') });
              result.scheduleItems += tasks.length;
            }
          }
        }
      }
    } catch { /* skip */ }
    return result;
  }

  /** Render navigation tabs at month/year level */
  // ═══════════════════════════════════════════════════════════
  // ══ GOALS MODE — Year-level dashboard
  // ═══════════════════════════════════════════════════════════

  private renderGoalsContent() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    if (this.nav.level === 'year' && this.nav.year) {
      this.renderYearlyGoalsDashboard();
    } else if (this.nav.level === 'month' && this.nav.year && this.nav.month) {
      this.renderMonthlyGoalsDashboard();
    } else {
      this.contentArea.createEl('p', {
        text: isRu ? 'Выберите год для просмотра целей' : 'Select a year to view goals',
        cls: 'planner-weekly-no-data',
      });
    }
    this.renderEditableBlocks('goal-tracker', isRu ? '🎯 Создать трекер целей' : '🎯 Create goal tracker');
  }

  // ═══════════════════════════════════════════════════════════
  // ══ PROJECTS MODE — Year-level dashboard
  // ═══════════════════════════════════════════════════════════

  private renderProjectsContent() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    if (this.nav.level === 'year' && this.nav.year) {
      this.renderProjectsDashboard();
    } else if (this.nav.level === 'month' && this.nav.year && this.nav.month) {
      this.renderProjectsDashboard();
    } else {
      this.contentArea.createEl('p', {
        text: isRu ? 'Выберите год для просмотра проектов' : 'Select a year to view projects',
        cls: 'planner-weekly-no-data',
      });
    }
    this.renderEditableBlocks('project-tracker', isRu ? '📋 Создать трекер проектов' : '📋 Create project tracker');
  }

  // ═══════════════════════════════════════════════════════════
  // ══ READING MODE — Year-level dashboard
  // ═══════════════════════════════════════════════════════════

  private renderReadingContent() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    if (this.nav.level === 'year' && this.nav.year) {
      this.renderReadingDashboard();
    } else if (this.nav.level === 'month' && this.nav.year && this.nav.month) {
      this.renderReadingDashboard();
    } else {
      this.contentArea.createEl('p', {
        text: isRu ? 'Выберите год для просмотра чтения' : 'Select a year to view reading',
        cls: 'planner-weekly-no-data',
      });
    }
    this.renderEditableBlocks('reading-log', isRu ? '📚 Создать журнал чтения' : '📚 Create reading log');
  }

  /** Render editable planner blocks for a given template */
  private renderEditableBlocks(templateName: string, createBtnText: string) {
    const blocks = this.plannerBlocks.filter(b => b.template === templateName);

    if (blocks.length === 0) {
      const createSection = this.contentArea.createDiv({ cls: 'planner-board-create-daily' });
      const createBtn = createSection.createEl('button', {
        text: createBtnText,
        cls: 'mod-cta',
      });
      createBtn.addEventListener('click', () => {
        void this.addPlannerToBoard(templateName);
      });
      return;
    }

    for (const block of blocks) {
      const card = this.contentArea.createDiv({ cls: 'planner-view-card' });
      const cardHeader = card.createDiv({ cls: 'planner-view-card-header' });
      cardHeader.createEl('h3', { text: block.title });
      const cardActions = cardHeader.createDiv({ cls: 'planner-view-card-actions' });
      const fileLink = cardActions.createEl('a', {
        text: block.file.replace(this.config.folder + '/', ''),
        cls: 'planner-view-card-file',
      });
      fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(block.file, '');
      });
      const cardBody = card.createDiv({ cls: 'planner-view-card-body planner-boards-root' });
      createPlanner(block.yaml, cardBody, {
        suppressTitle: true,
        onDataChange: async (newYaml: string) => {
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ══ SETTINGS MODE — Full settings page
  // ═══════════════════════════════════════════════════════════

  private renderSettingsPage() {
    this.contentArea.empty();
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const page = this.contentArea.createDiv({ cls: 'planner-settings-page' });

    // ── Sub-tab switcher ──
    const tabSwitcher = page.createDiv({ cls: 'planner-settings-tabs' });
    const tabs: { id: 'general' | 'dictionaries' | 'templates'; label: string }[] = [
      { id: 'general', label: `📂 ${isRu ? 'Основные' : 'General'}` },
      { id: 'dictionaries', label: `📖 ${isRu ? 'Словари' : 'Dictionaries'}` },
      { id: 'templates', label: `🛠 ${isRu ? 'Шаблоны' : 'Templates'}` },
    ];
    for (const tab of tabs) {
      const btn = tabSwitcher.createEl('button', {
        text: tab.label,
        cls: `planner-settings-tab-btn ${this.settingsTab === tab.id ? 'planner-settings-tab-btn-active' : ''}`,
      });
      btn.addEventListener('click', () => {
        if (this.settingsTab !== tab.id) {
          this.settingsTab = tab.id;
          this.renderSettingsPage();
        }
      });
    }

    const body = page.createDiv({ cls: 'planner-settings-body' });

    if (this.settingsTab === 'general') {
      this.renderSettingsGeneral(body);
    } else if (this.settingsTab === 'dictionaries') {
      this.renderSettingsDictionaries(body);
    } else if (this.settingsTab === 'templates') {
      this.renderSettingsTemplates(body);
    }

    // ── Save / Cancel buttons ──
    const btnRow = page.createDiv({ cls: 'planner-settings-buttons' });
    const saveBtn = btnRow.createEl('button', { text: isRu ? '💾 Сохранить' : '💾 Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => {
      this.saveConfig();
      this.activeMode = 'planner';
      void this.refresh().then(() => new Notice(isRu ? 'Настройки сохранены' : 'Settings saved'));
    });
    const cancelBtn = btnRow.createEl('button', { text: isRu ? 'Отмена' : 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.parseBoardConfig();
      this.activeMode = 'planner';
      this.buildHeader();
      this.buildBreadcrumb();
      this.buildTabs();
      this.renderContent();
    });
  }

  private renderSettingsGeneral(container: HTMLElement) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    // ── Folder settings ──
    const generalSection = container.createDiv({ cls: 'planner-settings-section' });
    generalSection.createEl('h3', { text: `📂 ${isRu ? 'Папки и формат' : 'Folders & Format'}` });

    new Setting(generalSection)
      .setName(isRu ? 'Папка данных' : 'Data folder')
      .setDesc(isRu ? 'Папка, в которой хранятся все файлы доски' : 'Folder where all board files are stored')
      .addDropdown(dropdown => {
        const folders = this.app.vault.getAllLoadedFiles()
          .filter((f): f is TFolder => f instanceof TFolder)
          .map(f => f.path)
          .sort();
        dropdown.addOption('', isRu ? '— Выбрать —' : '— Select —');
        for (const f of folders) dropdown.addOption(f, f);
        dropdown.setValue(this.config.folder)
          .onChange(val => { this.config.folder = val; });
      });

    new Setting(generalSection)
      .setName(isRu ? 'Папка ежедневных заметок' : 'Daily notes folder')
      .setDesc(isRu ? 'Папка для ежедневных заметок Obsidian' : 'Folder for Obsidian daily notes')
      .addDropdown(dropdown => {
        const folders = this.app.vault.getAllLoadedFiles()
          .filter((f): f is TFolder => f instanceof TFolder)
          .map(f => f.path)
          .sort();
        dropdown.addOption('Daily', 'Daily');
        for (const f of folders) dropdown.addOption(f, f);
        dropdown.setValue(this.config.dailyNotesFolder)
          .onChange(val => { this.config.dailyNotesFolder = val; });
      });

    new Setting(generalSection)
      .setName(isRu ? 'Формат даты' : 'Date format')
      .setDesc(isRu ? 'Формат имени ежедневной заметки (YYYY-MM-DD)' : 'Daily note name format (YYYY-MM-DD)')
      .addText(text => {
        text.setValue(this.config.dailyNoteFormat)
          .setPlaceholder('YYYY-MM-DD')
          .onChange(val => { this.config.dailyNoteFormat = val.trim() || 'YYYY-MM-DD'; });
      });

    // ── Template folders ──
    const foldersSection = container.createDiv({ cls: 'planner-settings-section' });
    foldersSection.createEl('h3', { text: `📁 ${isRu ? 'Папки шаблонов' : 'Template Folders'}` });
    foldersSection.createEl('p', {
      text: isRu ? 'Подпапки для файлов каждого шаблона' : 'Subfolders for each template\'s files',
      cls: 'setting-item-description',
    });

    const templates = this.plugin.getTemplates();
    for (const [key, tmpl] of Object.entries(templates)) {
      new Setting(foldersSection)
        .setName(tmpl.label)
        .addText(text => {
          text.setValue(this.config.templateFolders[key] || key)
            .setPlaceholder(key)
            .onChange(val => {
              const trimmed = val.trim();
              if (trimmed && trimmed !== key) {
                this.config.templateFolders[key] = trimmed;
              } else {
                delete this.config.templateFolders[key];
              }
            });
        });
    }

    // ── Calendar ──
    const calSection = container.createDiv({ cls: 'planner-settings-section' });
    calSection.createEl('h3', { text: `📅 ${isRu ? 'Календарь' : 'Calendar'}` });

    new Setting(calSection)
      .setName(isRu ? 'Показывать календарь' : 'Show calendar')
      .setDesc(isRu ? 'Отображать ICS календари на доске' : 'Display ICS calendars on the board')
      .addToggle(toggle => {
        toggle.setValue(this.config.showCalendar)
          .onChange(val => { this.config.showCalendar = val; });
      });

    if (this.config.showCalendar) {
      const sources = this.plugin.settings.calendar.sources;
      if (sources.length === 0) {
        calSection.createEl('p', {
          text: isRu ? 'Нет добавленных календарей. Добавьте в настройках плагина.' : 'No calendars added. Add them in plugin settings.',
          cls: 'setting-item-description',
        });
      } else {
        for (const source of sources) {
          const row = calSection.createDiv({ cls: 'planner-settings-cal-row' });
          const dot = row.createEl('span', { cls: 'planner-view-legend-dot' });
          dot.style.setProperty('--dot-color', source.color);
          const label = row.createEl('label', { cls: 'planner-settings-cal-label' });
          const cb = label.createEl('input', { type: 'checkbox' });
          cb.checked = this.config.calendars.includes(source.id);
          cb.addEventListener('change', () => {
            if (cb.checked) {
              if (!this.config.calendars.includes(source.id)) this.config.calendars.push(source.id);
            } else {
              this.config.calendars = this.config.calendars.filter(id => id !== source.id);
            }
          });
          label.createSpan({ text: ` ${source.name}` });
        }
      }
    }
  }

  private renderSettingsDictionaries(container: HTMLElement) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    container.createEl('p', {
      text: isRu
        ? 'Списки значений для выпадающих полей. Изменения применяются только к новым записям.'
        : 'Value lists for dropdown fields. Changes only apply to new entries.',
      cls: 'setting-item-description',
    });

    const groups: { title: string; icon: string; keys: { key: string; label: string }[] }[] = [
      {
        title: isRu ? 'Планер' : 'Planner', icon: '📅',
        keys: [
          { key: 'planner-categories', label: isRu ? 'Категории' : 'Categories' },
          { key: 'planner-weekly-priorities', label: isRu ? 'Приоритеты (недельные)' : 'Weekly Priorities' },
          { key: 'planner-daily-priorities', label: isRu ? 'Приоритеты (дневные)' : 'Daily Priorities' },
        ],
      },
      {
        title: isRu ? 'Финансы' : 'Finance', icon: '💰',
        keys: [
          { key: 'finance-fixed-categories', label: isRu ? 'Обязательные расходы' : 'Fixed Expenses' },
          { key: 'finance-variable-categories', label: isRu ? 'Переменные расходы' : 'Variable Expenses' },
        ],
      },
      {
        title: isRu ? 'Цели' : 'Goals', icon: '🎯',
        keys: [
          { key: 'goal-statuses', label: isRu ? 'Статусы' : 'Statuses' },
        ],
      },
      {
        title: isRu ? 'Проекты' : 'Projects', icon: '🚀',
        keys: [
          { key: 'project-statuses', label: isRu ? 'Статусы' : 'Statuses' },
          { key: 'project-priorities', label: isRu ? 'Приоритеты' : 'Priorities' },
        ],
      },
      {
        title: isRu ? 'Чтение' : 'Reading', icon: '📖',
        keys: [
          { key: 'reading-statuses', label: isRu ? 'Статусы' : 'Statuses' },
        ],
      },
    ];

    const defaults = this.getDefaultDictionaries();

    for (const group of groups) {
      const groupSection = container.createDiv({ cls: 'planner-settings-dict-group' });
      groupSection.createEl('h4', { text: `${group.icon} ${group.title}` });
      const grid = groupSection.createDiv({ cls: 'planner-settings-dict-grid' });

      for (const dk of group.keys) {
        const items = this.config.dictionaries[dk.key] || [];
        const dictBlock = grid.createDiv({ cls: 'planner-settings-dict' });
        const dictHeader = dictBlock.createDiv({ cls: 'planner-settings-dict-header' });
        dictHeader.createEl('strong', { text: dk.label });
        const resetBtn = dictHeader.createEl('button', {
          text: isRu ? 'Сбросить' : 'Reset',
          cls: 'planner-settings-dict-reset',
        });
        resetBtn.addEventListener('click', () => {
          if (defaults[dk.key]) {
            this.config.dictionaries[dk.key] = [...defaults[dk.key]];
            this.renderSettingsPage();
          }
        });

        const listEl = dictBlock.createDiv({ cls: 'planner-settings-dict-list' });
        items.forEach((item, idx) => {
          const row = listEl.createDiv({ cls: 'planner-settings-dict-row' });
          const input = row.createEl('input', { type: 'text', cls: 'planner-settings-dict-input' });
          input.value = item;
          input.addEventListener('change', () => {
            this.config.dictionaries[dk.key][idx] = input.value;
          });
          if (idx > 0) {
            const upBtn = row.createEl('button', { text: '↑', cls: 'planner-settings-dict-btn' });
            upBtn.addEventListener('click', () => {
              const arr = this.config.dictionaries[dk.key];
              [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
              this.renderSettingsPage();
            });
          }
          if (idx < items.length - 1) {
            const downBtn = row.createEl('button', { text: '↓', cls: 'planner-settings-dict-btn' });
            downBtn.addEventListener('click', () => {
              const arr = this.config.dictionaries[dk.key];
              [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
              this.renderSettingsPage();
            });
          }
          const delBtn = row.createEl('button', { text: '✕', cls: 'planner-settings-dict-btn planner-settings-dict-btn-del' });
          delBtn.addEventListener('click', () => {
            this.config.dictionaries[dk.key].splice(idx, 1);
            this.renderSettingsPage();
          });
        });

        const addRow = dictBlock.createDiv({ cls: 'planner-settings-dict-add' });
        const addInput = addRow.createEl('input', { type: 'text', cls: 'planner-settings-dict-input', placeholder: isRu ? 'Новое значение...' : 'New value...' });
        const addBtn = addRow.createEl('button', { text: '+', cls: 'planner-settings-dict-btn planner-settings-dict-btn-add' });
        addBtn.addEventListener('click', () => {
          const val = addInput.value.trim();
          if (val) {
            this.config.dictionaries[dk.key].push(val);
            this.renderSettingsPage();
          }
        });
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const val = addInput.value.trim();
            if (val) {
              this.config.dictionaries[dk.key].push(val);
              this.renderSettingsPage();
            }
          }
        });
      }
    }
  }

  private renderSettingsTemplates(container: HTMLElement) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    container.createEl('p', {
      text: isRu
        ? 'Редактируйте шаблоны по умолчанию. Данные из шаблонов будут подставляться при создании новых записей (например, привычки, кредиты).'
        : 'Edit default templates. Data from templates will be used when creating new entries (e.g., habits, creditors).',
      cls: 'setting-item-description',
    });

    const templateConfigs: { key: string; label: string; icon: string }[] = [
      { key: 'daily-planner', label: isRu ? 'Ежедневник' : 'Daily Planner', icon: '📅' },
      { key: 'daily-finance', label: isRu ? 'Финансы (день)' : 'Daily Finance', icon: '💰' },
      { key: 'finance-planner', label: isRu ? 'Бюджет (месяц)' : 'Monthly Budget', icon: '📊' },
      { key: 'goal-tracker', label: isRu ? 'Цели OKR' : 'Goals OKR', icon: '🎯' },
      { key: 'project-tracker', label: isRu ? 'Проекты' : 'Projects', icon: '🚀' },
      { key: 'reading-log', label: isRu ? 'Чтение' : 'Reading Log', icon: '📖' },
    ];

    for (const tc of templateConfigs) {
      const section = container.createDiv({ cls: 'planner-settings-template' });
      const header = section.createDiv({ cls: 'planner-settings-template-header' });
      header.createEl('strong', { text: `${tc.icon} ${tc.label}` });

      const headerActions = header.createDiv({ cls: 'planner-settings-template-actions' });
      const subFolder = this.config.templateFolders[tc.key] || tc.key;
      headerActions.createEl('span', { text: `📁 ${subFolder}`, cls: 'planner-settings-template-folder' });

      // Reset button
      const resetBtn = headerActions.createEl('button', {
        text: isRu ? 'Сбросить' : 'Reset',
        cls: 'planner-settings-dict-reset',
      });
      resetBtn.addEventListener('click', () => {
        delete this.config.templateDefaults[tc.key];
        this.renderSettingsPage();
      });

      // Get or generate the template YAML
      const templates = this.plugin.getTemplates();
      const tmpl = templates[tc.key];
      if (!tmpl) continue;

      let templateYaml: string;
      if (this.config.templateDefaults[tc.key]) {
        templateYaml = this.config.templateDefaults[tc.key];
      } else {
        templateYaml = this.injectDictionaries(tmpl.generator(this.plugin.settings), tc.key);
      }

      // Render actual planner preview
      const previewBody = section.createDiv({ cls: 'planner-settings-template-preview planner-boards-root' });
      try {
        createPlanner(templateYaml, previewBody, {
          suppressTitle: true,
          onDataChange: (newYaml: string) => {
            this.config.templateDefaults[tc.key] = newYaml;
          },
        });
      } catch {
        previewBody.createEl('p', { text: isRu ? 'Ошибка загрузки шаблона' : 'Template load error', cls: 'planner-weekly-no-data' });
      }
    }
  }

  /** Render dedicated finance dashboard */

  /** Parse a finance-planner block and return structured budget data */
  private parseFinanceBlock(block: PlannerBlock): {
    income: { category: string; planned: number; actual: number }[];
    fixed: { category: string; planned: number; actual: number }[];
    variable: { category: string; planned: number; actual: number }[];
    debts: { category: string; planned: number; actual: number }[];
    savings: { category: string; planned: number; actual: number }[];
    totals: { income: { planned: number; actual: number }; fixed: { planned: number; actual: number }; variable: { planned: number; actual: number }; debts: { planned: number; actual: number }; savings: { planned: number; actual: number } };
  } {
    const empty = { income: [], fixed: [], variable: [], debts: [], savings: [], totals: { income: { planned: 0, actual: 0 }, fixed: { planned: 0, actual: 0 }, variable: { planned: 0, actual: 0 }, debts: { planned: 0, actual: 0 }, savings: { planned: 0, actual: 0 } } };
    try {
      const schema = parseSchema(block.yaml);
      const expanded = schema.template ? expandTemplate(schema) : schema;
      const sections = (expanded as PlannerSchema).sections;
      if (!sections) return empty;

      const parseSection = (dataKey: string, catField: string) => {
        const items = (sections[dataKey] as Record<string, string | number | boolean>[] | undefined) || [];
        return items.filter((i: Record<string, string | number | boolean>) => i[catField] || i.category).map((i: Record<string, string | number | boolean>) => ({
          category: i[catField] || i.category || '',
          planned: i.planned || i.payment || i.target || 0,
          actual: i.actual || i.paid || i.current || 0,
        }));
      };

      const result = {
        income: parseSection('income', 'category'),
        fixed: parseSection('fixed_expenses', 'category'),
        variable: parseSection('variable_expenses', 'category'),
        debts: parseSection('debts', 'creditor'),
        savings: parseSection('savings', 'goal'),
        totals: { income: { planned: 0, actual: 0 }, fixed: { planned: 0, actual: 0 }, variable: { planned: 0, actual: 0 }, debts: { planned: 0, actual: 0 }, savings: { planned: 0, actual: 0 } },
      };

      for (const key of ['income', 'fixed', 'variable', 'debts', 'savings'] as const) {
        for (const item of result[key]) {
          result.totals[key].planned += item.planned;
          result.totals[key].actual += item.actual;
        }
      }

      return result;
    } catch { return empty; }
  }

  /** Render monthly finance dashboard — full detailed view */
  private renderMonthlyFinanceDashboard() {
    const year = this.nav.year!;
    const month = this.nav.month!;
    const monthPad = String(month).padStart(2, '0');
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const monthNames = getMonthNames();
    const daysInMonth = new Date(year, month, 0).getDate();

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `💰 ${isRu ? 'Финансы' : 'Finance'}: ${monthNames[month - 1]} ${year}` });

    // Get daily-finance blocks for actual data
    const startDate = `${year}-${monthPad}-01`;
    const endDate = `${year}-${monthPad}-${String(daysInMonth).padStart(2, '0')}`;
    const dailyFinBlocks = this.getFinanceBlocksForRange(startDate, endDate);

    // Get finance-planner block for budget plan
    const finPlanBlocks = this.plannerBlocks.filter(b => b.template === 'finance-planner' && b.month === `${year}-${monthPad}`);
    const hasBudget = finPlanBlocks.length > 0;
    const budgetData = hasBudget ? this.parseFinanceBlock(finPlanBlocks[0]) : null;

    // Parse daily-finance data
    const dailyData: { day: string; data: ReturnType<typeof this.parseDailyFinanceData> }[] = [];
    const dailyTotals = { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    for (const block of dailyFinBlocks) {
      const data = this.parseDailyFinanceData(block);
      dailyData.push({ day: block.day!, data });
      dailyTotals.income += data.totals.income;
      dailyTotals.fixed += data.totals.fixed;
      dailyTotals.variable += data.totals.variable;
      dailyTotals.debts += data.totals.debts;
      dailyTotals.savings += data.totals.savings;
    }
    const hasDaily = dailyData.length > 0;

    // Actual values: daily-finance replaces finance-planner actuals if available
    let actualTotals: { income: number; fixed: number; variable: number; debts: number; savings: number };
    if (hasDaily) {
      actualTotals = { ...dailyTotals };
    } else if (hasBudget) {
      actualTotals = {
        income: budgetData!.totals.income.actual,
        fixed: budgetData!.totals.fixed.actual,
        variable: budgetData!.totals.variable.actual,
        debts: budgetData!.totals.debts.actual,
        savings: budgetData!.totals.savings.actual,
      };
    } else {
      actualTotals = { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    }
    const actualExpenses = actualTotals.fixed + actualTotals.variable + actualTotals.debts + actualTotals.savings;
    const actualBalance = actualTotals.income - actualExpenses;

    if (!hasDaily && !hasBudget) {
      dashboard.createEl('p', { text: isRu ? 'Нет финансовых данных за этот месяц.' : 'No finance data for this month.', cls: 'planner-weekly-no-data' });
      return;
    }

    // Budget plan values
    const planTotals = budgetData ? {
      income: budgetData.totals.income.planned,
      fixed: budgetData.totals.fixed.planned,
      variable: budgetData.totals.variable.planned,
      debts: budgetData.totals.debts.planned,
      savings: budgetData.totals.savings.planned,
    } : { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    const planExpenses = planTotals.fixed + planTotals.variable + planTotals.debts + planTotals.savings;
    const planBalance = planTotals.income - planExpenses;
    const avgDailyExpense = hasDaily ? Math.round(actualExpenses / dailyData.length) : 0;

    // ═══ ROW 0: Stat cards ═══
    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    const statCards: [string, string, string][] = [
      [isRu ? 'Баланс (факт)' : 'Balance (actual)', actualBalance.toLocaleString(), actualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad'],
      [isRu ? 'Доходы' : 'Income', actualTotals.income.toLocaleString(), ''],
      [isRu ? 'Расходы' : 'Expenses', actualExpenses.toLocaleString(), ''],
      [isRu ? 'Дней' : 'Days', `${dailyData.length} / ${daysInMonth}`, ''],
    ];
    if (hasBudget) {
      statCards.push([isRu ? 'Бюджет (план)' : 'Budget (plan)', planBalance.toLocaleString(), planBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad']);
    }
    if (hasDaily) {
      statCards.push([isRu ? 'Ср. расход/день' : 'Avg/day', avgDailyExpense.toLocaleString(), '']);
    }
    for (const [lbl, val, cls] of statCards) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      const valEl = card.createDiv({ cls: 'planner-stat-value', text: val });
      if (cls) valEl.classList.add(cls);
      card.createDiv({ cls: 'planner-stat-label', text: lbl });
    }

    // ═══ ROW 1: Summary table Plan/Fact (left) + Compare bars (right) ═══
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // Left: summary table
    const summaryBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = summaryBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'Сводка за месяц' : 'Monthly Summary'}` });
      const tbl = summaryBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
      if (hasBudget) th.createEl('th', { text: isRu ? 'План' : 'Plan' });
      th.createEl('th', { text: isRu ? 'Факт' : 'Actual' });
      if (hasBudget) th.createEl('th', { text: isRu ? 'Разница' : 'Diff' });
      th.createEl('th', { text: '%' });
      const tb = tbl.createEl('tbody');

      const rows: [string, string, number, number][] = [
        ['➕', isRu ? 'Доходы' : 'Income', planTotals.income, actualTotals.income],
        ['➖', isRu ? 'Обязательные' : 'Fixed', planTotals.fixed, actualTotals.fixed],
        ['➖', isRu ? 'Переменные' : 'Variable', planTotals.variable, actualTotals.variable],
        ['➖', isRu ? 'Долги' : 'Debts', planTotals.debts, actualTotals.debts],
        ['➖', isRu ? 'Накопления' : 'Savings', planTotals.savings, actualTotals.savings],
      ];
      for (const [icon, label, planned, actual] of rows) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: `${icon} ${label}` });
        if (hasBudget) tr.createEl('td', { text: planned.toLocaleString(), cls: 'planner-summary-number' });
        tr.createEl('td', { text: actual.toLocaleString(), cls: 'planner-summary-number' });
        if (hasBudget) {
          const diff = icon === '➕' ? actual - planned : planned - actual;
          const diffCell = tr.createEl('td', { text: diff.toLocaleString(), cls: 'planner-summary-number' });
          diffCell.classList.add(diff >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
        }
        // % of income (for expenses) or % of budget (for income)
        const pct = icon === '➕'
          ? (hasBudget && planned > 0 ? Math.round((actual / planned) * 100) : 0)
          : (actualTotals.income > 0 ? Math.round((actual / actualTotals.income) * 100) : 0);
        tr.createEl('td', { text: icon === '➕' ? (hasBudget ? `${pct}%` : '—') : `${pct}%`, cls: 'planner-summary-number' });
      }
      const totalRow = tbl.createEl('tfoot').createEl('tr');
      totalRow.createEl('td', { text: `🟰 ${isRu ? 'Баланс' : 'Balance'}` });
      if (hasBudget) totalRow.createEl('td', { text: planBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      const balCell = totalRow.createEl('td', { text: actualBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      balCell.classList.add(actualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
      if (hasBudget) totalRow.createEl('td');
      totalRow.createEl('td');
    }

    // Right: compare bars (plan vs actual) or just actual bars
    const breakdownBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = breakdownBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? (hasBudget ? 'План / Факт' : 'По категориям') : (hasBudget ? 'Plan vs Actual' : 'By Category')}` });
      const sections: [string, string, number, number][] = [
        ['💵', isRu ? 'Доходы' : 'Income', planTotals.income, actualTotals.income],
        ['🏠', isRu ? 'Обязат.' : 'Fixed', planTotals.fixed, actualTotals.fixed],
        ['🛒', isRu ? 'Перемен.' : 'Variable', planTotals.variable, actualTotals.variable],
        ['💳', isRu ? 'Долги' : 'Debts', planTotals.debts, actualTotals.debts],
        ['🏦', isRu ? 'Наколл.' : 'Savings', planTotals.savings, actualTotals.savings],
      ];
      const maxVal = Math.max(...sections.map(s => Math.max(s[2], s[3])), 1);

      for (const [icon, label, planned, actual] of sections) {
        const wrap = breakdownBlock.createDiv({ cls: 'planner-finance-compare-row' });
        wrap.createDiv({ cls: 'planner-finance-compare-label', text: `${icon} ${label}` });
        const barsWrap = wrap.createDiv({ cls: 'planner-finance-compare-bars' });
        if (hasBudget) {
          const planBar = barsWrap.createDiv({ cls: 'planner-finance-compare-bar planner-finance-bar-plan' });
          planBar.style.setProperty('--bar-width', `${Math.round((planned / maxVal) * 100)}%`);
          planBar.createSpan({ text: planned.toLocaleString(), cls: 'planner-finance-bar-text' });
        }
        const actBar = barsWrap.createDiv({ cls: 'planner-finance-compare-bar planner-finance-bar-actual' });
        actBar.style.setProperty('--bar-width', `${Math.round((actual / maxVal) * 100)}%`);
        actBar.createSpan({ text: actual.toLocaleString(), cls: 'planner-finance-bar-text' });
      }
      if (hasBudget) {
        const legend = breakdownBlock.createDiv({ cls: 'planner-finance-legend' });
        legend.createSpan({ cls: 'planner-finance-legend-plan', text: isRu ? '■ План' : '■ Plan' });
        legend.createSpan({ cls: 'planner-finance-legend-actual', text: isRu ? '■ Факт' : '■ Actual' });
      }
    }

    // ═══ ROW 2: Weekly breakdown (left) + Daily spending chart (right) ═══
    if (hasDaily) {
      const row2 = dashboard.createDiv({ cls: 'planner-weekly-row' });

      // Left: weekly breakdown table
      const weekBlock = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      {
        const hdr = weekBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `📋 ${isRu ? 'По неделям' : 'By Week'}` });
        // Group daily data by week
        const weeks = getWeeksInMonth(year, month);
        const tbl = weekBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Неделя' : 'Week' });
        th.createEl('th', { text: '💵' });
        th.createEl('th', { text: '💸' });
        th.createEl('th', { text: '🟰' });
        th.createEl('th', { text: isRu ? 'Дней' : 'Days' });
        const tb = tbl.createEl('tbody');
        for (const w of weeks) {
          const wStart = `${w.start.getFullYear()}-${String(w.start.getMonth() + 1).padStart(2, '0')}-${String(w.start.getDate()).padStart(2, '0')}`;
          const wEnd = `${w.end.getFullYear()}-${String(w.end.getMonth() + 1).padStart(2, '0')}-${String(w.end.getDate()).padStart(2, '0')}`;
          const wDays = dailyData.filter(d => d.day >= wStart && d.day <= wEnd);
          if (wDays.length === 0) continue;
          let wInc = 0, wExp = 0;
          for (const wd of wDays) {
            wInc += wd.data.totals.income;
            wExp += wd.data.totals.fixed + wd.data.totals.variable + wd.data.totals.debts + wd.data.totals.savings;
          }
          const wBal = wInc - wExp;
          const wLabel = `${w.start.getDate()} ${getMonthShort()[w.start.getMonth()]} — ${w.end.getDate()} ${getMonthShort()[w.end.getMonth()]}`;
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: wLabel, cls: 'planner-clickable' }).addEventListener('click', () => {
            this.nav.week = w.week;
            this.nav.level = 'week';
            this.renderContent();
          });
          tr.createEl('td', { text: wInc.toLocaleString(), cls: 'planner-summary-number' });
          tr.createEl('td', { text: wExp.toLocaleString(), cls: 'planner-summary-number' });
          const wBalCell = tr.createEl('td', { text: wBal.toLocaleString(), cls: 'planner-summary-number' });
          wBalCell.classList.add(wBal >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
          tr.createEl('td', { text: String(wDays.length), cls: 'planner-summary-number' });
        }
        const totalRow = tbl.createEl('tfoot').createEl('tr');
        totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
        totalRow.createEl('td', { text: actualTotals.income.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
        totalRow.createEl('td', { text: actualExpenses.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
        const balTotal = totalRow.createEl('td', { text: actualBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
        balTotal.classList.add(actualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
        totalRow.createEl('td', { text: String(dailyData.length), cls: 'planner-summary-number planner-summary-total' });
      }

      // Right: daily income vs expenses chart
      const chartBlock = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      {
        const hdr = chartBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `📈 ${isRu ? 'Доходы / Расходы по дням' : 'Income / Expenses by Day'}` });
        const chartEl = chartBlock.createDiv({ cls: 'planner-yearly-chart planner-finance-dual-chart' });
        const dayChartData = dailyData.map(d => ({
          label: d.day.substring(8),
          income: d.data.totals.income,
          expenses: d.data.totals.fixed + d.data.totals.variable + d.data.totals.debts + d.data.totals.savings,
        }));
        const maxVal = Math.max(...dayChartData.flatMap(d => [d.income, d.expenses]), 1);
        for (const dc of dayChartData) {
          const barGroup = chartEl.createDiv({ cls: 'planner-yearly-chart-bar-group' });
          const incBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-income' });
          incBar.style.setProperty('--bar-height', `${Math.round((dc.income / maxVal) * 100)}%`);
          incBar.setAttribute('aria-label', `${isRu ? 'Доход' : 'Income'}: ${dc.income.toLocaleString()}`);
          const expBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-expense' });
          expBar.style.setProperty('--bar-height', `${Math.round((dc.expenses / maxVal) * 100)}%`);
          expBar.setAttribute('aria-label', `${isRu ? 'Расход' : 'Expense'}: ${dc.expenses.toLocaleString()}`);
          barGroup.createDiv({ cls: 'planner-yearly-chart-label', text: dc.label });
        }
        const legend = chartBlock.createDiv({ cls: 'planner-finance-legend' });
        legend.createSpan({ cls: 'planner-finance-legend-income', text: isRu ? '■ Доходы' : '■ Income' });
        legend.createSpan({ cls: 'planner-finance-legend-expense', text: isRu ? '■ Расходы' : '■ Expenses' });
      }
    }

    // ═══ ROW 3: Detail tables from finance-planner sections ═══
    if (hasBudget && budgetData) {
      const sectionDefs: [string, string, { category: string; planned: number; actual: number }[]][] = [
        ['💵', isRu ? 'Доходы' : 'Income', budgetData.income],
        ['🏠', isRu ? 'Обязательные расходы' : 'Fixed Expenses', budgetData.fixed],
        ['🛒', isRu ? 'Переменные расходы' : 'Variable Expenses', budgetData.variable],
        ['💳', isRu ? 'Долги' : 'Debts', budgetData.debts],
        ['🏦', isRu ? 'Накопления' : 'Savings', budgetData.savings],
      ];
      const filteredSections = sectionDefs.filter(([, , items]) => items.length > 0);
      for (let i = 0; i < filteredSections.length; i += 2) {
        const detailRow = dashboard.createDiv({ cls: 'planner-weekly-row' });
        for (let j = i; j < Math.min(i + 2, filteredSections.length); j++) {
          const [icon, title, items] = filteredSections[j];
          const detailBlock = detailRow.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr = detailBlock.createDiv({ cls: 'planner-weekly-block-header' });
          hdr.createEl('h4', { text: `${icon} ${title}` });
          const tbl = detailBlock.createEl('table', { cls: 'planner-summary-table' });
          const th = tbl.createEl('thead').createEl('tr');
          th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th.createEl('th', { text: isRu ? 'План' : 'Plan' });
          th.createEl('th', { text: isRu ? 'Факт' : 'Actual' });
          th.createEl('th', { text: isRu ? 'Разница' : 'Diff' });
          const tb = tbl.createEl('tbody');
          let totalPlanned = 0, totalActual = 0;
          for (const item of items) {
            const tr = tb.createEl('tr');
            tr.createEl('td', { text: item.category });
            tr.createEl('td', { text: item.planned.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: item.actual.toLocaleString(), cls: 'planner-summary-number' });
            const diff = item.actual - item.planned;
            const diffCell = tr.createEl('td', { text: diff.toLocaleString(), cls: 'planner-summary-number' });
            diffCell.classList.add(diff >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
            totalPlanned += item.planned;
            totalActual += item.actual;
          }
          const totalRow = tbl.createEl('tfoot').createEl('tr');
          totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
          totalRow.createEl('td', { text: totalPlanned.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalRow.createEl('td', { text: totalActual.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          const totalDiff = totalActual - totalPlanned;
          const totalDiffCell = totalRow.createEl('td', { text: totalDiff.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalDiffCell.classList.add(totalDiff >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
        }
      }
    }

    // ═══ ROW 4: Variable by category + Fixed by category (from daily-finance) ═══
    if (hasDaily) {
      const varCatMap = new Map<string, number>();
      const fixCatMap = new Map<string, number>();
      for (const { data } of dailyData) {
        for (const v of data.variable) {
          const cat = v.category || (isRu ? 'Другое' : 'Other');
          varCatMap.set(cat, (varCatMap.get(cat) || 0) + v.amount);
        }
        for (const f of data.fixed) {
          const cat = f.category || (isRu ? 'Другое' : 'Other');
          fixCatMap.set(cat, (fixCatMap.get(cat) || 0) + f.amount);
        }
      }

      if (varCatMap.size > 0 || fixCatMap.size > 0) {
        const row4 = dashboard.createDiv({ cls: 'planner-weekly-row' });

        // Variable by category
        if (varCatMap.size > 0) {
          const catBlock = row4.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr = catBlock.createDiv({ cls: 'planner-weekly-block-header' });
          hdr.createEl('h4', { text: `🛒 ${isRu ? 'Переменные по категориям' : 'Variable by Category'}` });
          const sorted = [...varCatMap.entries()].sort((a, b) => b[1] - a[1]);
          const maxVal = sorted[0][1];
          const catTotal = sorted.reduce((s, [, v]) => s + v, 0);
          const tbl = catBlock.createEl('table', { cls: 'planner-summary-table' });
          const th = tbl.createEl('thead').createEl('tr');
          th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
          th.createEl('th', { text: '%' });
          th.createEl('th', { text: '' });
          const tb = tbl.createEl('tbody');
          for (const [cat, amount] of sorted) {
            const tr = tb.createEl('tr');
            tr.createEl('td', { text: cat });
            tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: `${Math.round((amount / catTotal) * 100)}%`, cls: 'planner-summary-number' });
            const barCell = tr.createEl('td');
            const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
            bar.addClass('planner-chart-bar-fixed');
            const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
            fill.style.setProperty('--bar-width', `${Math.round((amount / maxVal) * 100)}%`);
            fill.addClass('planner-fill-accent');
          }
          // Total row
          const totalRow = tbl.createEl('tfoot').createEl('tr');
          totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
          totalRow.createEl('td', { text: catTotal.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalRow.createEl('td', { text: '100%', cls: 'planner-summary-number' });
          totalRow.createEl('td');
        }

        // Fixed by category
        if (fixCatMap.size > 0) {
          const fixBlock = row4.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr = fixBlock.createDiv({ cls: 'planner-weekly-block-header' });
          hdr.createEl('h4', { text: `🏠 ${isRu ? 'Обязательные по категориям' : 'Fixed by Category'}` });
          const sorted = [...fixCatMap.entries()].sort((a, b) => b[1] - a[1]);
          const maxVal = sorted[0][1];
          const fixTotal = sorted.reduce((s, [, v]) => s + v, 0);
          const tbl = fixBlock.createEl('table', { cls: 'planner-summary-table' });
          const th = tbl.createEl('thead').createEl('tr');
          th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
          th.createEl('th', { text: '%' });
          th.createEl('th', { text: '' });
          const tb = tbl.createEl('tbody');
          for (const [cat, amount] of sorted) {
            const tr = tb.createEl('tr');
            tr.createEl('td', { text: cat });
            tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: `${Math.round((amount / fixTotal) * 100)}%`, cls: 'planner-summary-number' });
            const barCell = tr.createEl('td');
            const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
            bar.addClass('planner-chart-bar-fixed');
            const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
            fill.style.setProperty('--bar-width', `${Math.round((amount / maxVal) * 100)}%`);
            fill.addClass('planner-fill-accent');
          }
          const totalRow = tbl.createEl('tfoot').createEl('tr');
          totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
          totalRow.createEl('td', { text: fixTotal.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalRow.createEl('td', { text: '100%', cls: 'planner-summary-number' });
          totalRow.createEl('td');
        }
      }

      // ═══ ROW 5: Top expenses list ═══
      const allExpenses: { day: string; category: string; description: string; amount: number }[] = [];
      for (const { day, data } of dailyData) {
        for (const v of data.variable) {
          if (v.amount > 0) allExpenses.push({ day, category: v.category || (isRu ? 'Другое' : 'Other'), description: v.description || '', amount: v.amount });
        }
        for (const f of data.fixed) {
          if (f.amount > 0) allExpenses.push({ day, category: `🏠 ${f.category || ''}`, description: '', amount: f.amount });
        }
      }
      if (allExpenses.length > 0) {
        allExpenses.sort((a, b) => b.amount - a.amount);
        const top = allExpenses.slice(0, 10);
        const row5 = dashboard.createDiv({ cls: 'planner-weekly-row' });
        const topBlock = row5.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
        const hdr = topBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `🔝 ${isRu ? 'Топ-10 расходов' : 'Top 10 Expenses'}` });
        const tbl = topBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Дата' : 'Date' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Описание' : 'Description' });
        th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
        const tb = tbl.createEl('tbody');
        for (const exp of top) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: exp.day.substring(5), cls: 'planner-clickable' }).addEventListener('click', () => this.navigateToDay(exp.day));
          tr.createEl('td', { text: exp.category });
          tr.createEl('td', { text: exp.description || '—' });
          tr.createEl('td', { text: exp.amount.toLocaleString(), cls: 'planner-summary-number' });
        }
      }
    }
  }

  /** Render yearly finance dashboard — full detailed view */
  private renderYearlyFinanceDashboard() {
    const year = this.nav.year!;
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const monthNames = getMonthNames();

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `💰 ${isRu ? 'Финансы' : 'Finance'}: ${year}` });

    // Get all daily-finance blocks for the year
    const allDailyFin = this.plannerBlocks.filter(b => b.template === 'daily-finance' && b.day && b.day.startsWith(`${year}-`));
    // Get all finance-planner blocks for budget
    const finPlanBlocks = this.plannerBlocks.filter(b => b.template === 'finance-planner' && b.month && b.month.startsWith(`${year}-`));

    if (allDailyFin.length === 0 && finPlanBlocks.length === 0) {
      dashboard.createEl('p', { text: isRu ? 'Нет финансовых данных за этот год.' : 'No finance data for this year.', cls: 'planner-weekly-no-data' });
      return;
    }

    const hasBudget = finPlanBlocks.length > 0;
    const hasDaily = allDailyFin.length > 0;

    // Aggregate daily-finance by month
    type MonthData = { income: number; fixed: number; variable: number; debts: number; savings: number; days: number };
    const monthActuals = new Map<number, MonthData>();
    for (const block of allDailyFin) {
      const m = parseInt(block.day!.split('-')[1]);
      const data = this.parseDailyFinanceData(block);
      const existing = monthActuals.get(m) || { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0, days: 0 };
      existing.income += data.totals.income;
      existing.fixed += data.totals.fixed;
      existing.variable += data.totals.variable;
      existing.debts += data.totals.debts;
      existing.savings += data.totals.savings;
      existing.days++;
      monthActuals.set(m, existing);
    }

    // Parse budget plans and actuals per month
    const monthPlans = new Map<number, { income: number; fixed: number; variable: number; debts: number; savings: number }>();
    const monthBudgetActuals = new Map<number, { income: number; fixed: number; variable: number; debts: number; savings: number }>();
    for (const fb of finPlanBlocks) {
      const m = parseInt(fb.month!.split('-')[1]);
      const data = this.parseFinanceBlock(fb);
      monthPlans.set(m, {
        income: data.totals.income.planned,
        fixed: data.totals.fixed.planned,
        variable: data.totals.variable.planned,
        debts: data.totals.debts.planned,
        savings: data.totals.savings.planned,
      });
      monthBudgetActuals.set(m, {
        income: data.totals.income.actual,
        fixed: data.totals.fixed.actual,
        variable: data.totals.variable.actual,
        debts: data.totals.debts.actual,
        savings: data.totals.savings.actual,
      });
    }

    // Collect all months
    const allMonths = new Set<number>();
    monthActuals.forEach((_, m) => allMonths.add(m));
    monthPlans.forEach((_, m) => allMonths.add(m));
    const sortedMonths = [...allMonths].sort((a, b) => a - b);

    // Yearly totals — prefer daily-finance actuals, fallback to finance-planner actuals
    let yearActual = { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    let yearPlan = { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    let totalDays = 0;
    for (const m of sortedMonths) {
      const act = monthActuals.get(m) || monthBudgetActuals.get(m);
      const plan = monthPlans.get(m);
      if (act) { yearActual.income += act.income; yearActual.fixed += act.fixed; yearActual.variable += act.variable; yearActual.debts += act.debts; yearActual.savings += act.savings; }
      if (monthActuals.has(m)) totalDays += monthActuals.get(m)!.days;
      if (plan) { yearPlan.income += plan.income; yearPlan.fixed += plan.fixed; yearPlan.variable += plan.variable; yearPlan.debts += plan.debts; yearPlan.savings += plan.savings; }
    }
    const yearActualExpenses = yearActual.fixed + yearActual.variable + yearActual.debts + yearActual.savings;
    const yearActualBalance = yearActual.income - yearActualExpenses;
    const yearPlanExpenses = yearPlan.fixed + yearPlan.variable + yearPlan.debts + yearPlan.savings;
    const yearPlanBalance = yearPlan.income - yearPlanExpenses;
    const avgMonthlyExpense = sortedMonths.length > 0 ? Math.round(yearActualExpenses / sortedMonths.length) : 0;

    // ═══ ROW 0: Stat cards ═══
    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    const statCards: [string, string, string][] = [
      [isRu ? 'Годовой баланс' : 'Year Balance', yearActualBalance.toLocaleString(), yearActualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad'],
      [isRu ? 'Годовой доход' : 'Year Income', yearActual.income.toLocaleString(), ''],
      [isRu ? 'Годовые расходы' : 'Year Expenses', yearActualExpenses.toLocaleString(), ''],
      [isRu ? 'Месяцев' : 'Months', String(sortedMonths.length), ''],
    ];
    if (hasBudget) {
      statCards.push([isRu ? 'Бюджет (план)' : 'Budget (plan)', yearPlanBalance.toLocaleString(), yearPlanBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad']);
    }
    if (sortedMonths.length > 0) {
      statCards.push([isRu ? 'Ср. расход/мес' : 'Avg/month', avgMonthlyExpense.toLocaleString(), '']);
    }
    for (const [lbl, val, cls] of statCards) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      const valEl = card.createDiv({ cls: 'planner-stat-value', text: val });
      if (cls) valEl.classList.add(cls);
      card.createDiv({ cls: 'planner-stat-label', text: lbl });
    }

    // ═══ ROW 1: Month-by-month table (left) + Category breakdown (right) ═══
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // Left: month table
    const summaryBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = summaryBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📋 ${isRu ? 'По месяцам' : 'By Month'}` });
      const tbl = summaryBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Месяц' : 'Month' });
      th.createEl('th', { text: `💵 ${isRu ? 'Доход' : 'Income'}` });
      th.createEl('th', { text: `💸 ${isRu ? 'Расход' : 'Expense'}` });
      th.createEl('th', { text: `🟰 ${isRu ? 'Баланс' : 'Balance'}` });
      th.createEl('th', { text: isRu ? 'Дней' : 'Days' });
      const tb = tbl.createEl('tbody');
      for (const m of sortedMonths) {
        const dailyAct = monthActuals.get(m);
        const budgetAct = monthBudgetActuals.get(m);
        const act = dailyAct || (budgetAct ? { ...budgetAct, days: 0 } : { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0, days: 0 });
        const totalExp = act.fixed + act.variable + act.debts + act.savings;
        const bal = act.income - totalExp;
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: monthNames[m - 1], cls: 'planner-clickable' }).addEventListener('click', () => {
          this.nav.month = m;
          this.nav.level = 'month';
          this.renderContent();
        });
        tr.createEl('td', { text: act.income.toLocaleString(), cls: 'planner-summary-number' });
        tr.createEl('td', { text: totalExp.toLocaleString(), cls: 'planner-summary-number' });
        const balCell = tr.createEl('td', { text: bal.toLocaleString(), cls: 'planner-summary-number' });
        balCell.classList.add(bal >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
        tr.createEl('td', { text: String(act.days), cls: 'planner-summary-number' });
      }
      const totalRow = tbl.createEl('tfoot').createEl('tr');
      totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
      totalRow.createEl('td', { text: yearActual.income.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      totalRow.createEl('td', { text: yearActualExpenses.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      const balTotalCell = totalRow.createEl('td', { text: yearActualBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      balTotalCell.classList.add(yearActualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
      totalRow.createEl('td', { text: String(totalDays), cls: 'planner-summary-number planner-summary-total' });
    }

    // Right: category summary with Plan/Fact/Diff + %
    const catBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = catBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'Сводка по категориям' : 'Category Summary'}` });
      const tbl = catBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
      if (hasBudget) th.createEl('th', { text: isRu ? 'План' : 'Plan' });
      th.createEl('th', { text: isRu ? 'Факт' : 'Actual' });
      if (hasBudget) th.createEl('th', { text: isRu ? 'Разница' : 'Diff' });
      th.createEl('th', { text: '%' });
      const tb = tbl.createEl('tbody');

      const catRows: [string, string, number, number][] = [
        ['💵', isRu ? 'Доходы' : 'Income', yearPlan.income, yearActual.income],
        ['🏠', isRu ? 'Обязат.' : 'Fixed', yearPlan.fixed, yearActual.fixed],
        ['🛒', isRu ? 'Перемен.' : 'Variable', yearPlan.variable, yearActual.variable],
        ['💳', isRu ? 'Долги' : 'Debts', yearPlan.debts, yearActual.debts],
        ['🏦', isRu ? 'Наколл.' : 'Savings', yearPlan.savings, yearActual.savings],
      ];
      for (const [icon, label, planned, actual] of catRows) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: `${icon} ${label}` });
        if (hasBudget) tr.createEl('td', { text: planned.toLocaleString(), cls: 'planner-summary-number' });
        tr.createEl('td', { text: actual.toLocaleString(), cls: 'planner-summary-number' });
        if (hasBudget) {
          const diff = icon === '💵' ? actual - planned : planned - actual;
          const diffCell = tr.createEl('td', { text: diff.toLocaleString(), cls: 'planner-summary-number' });
          diffCell.classList.add(diff >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
        }
        const pct = icon === '💵'
          ? (hasBudget && planned > 0 ? Math.round((actual / planned) * 100) : 0)
          : (yearActual.income > 0 ? Math.round((actual / yearActual.income) * 100) : 0);
        tr.createEl('td', { text: icon === '💵' ? (hasBudget ? `${pct}%` : '—') : `${pct}%`, cls: 'planner-summary-number' });
      }
      const totalRow = tbl.createEl('tfoot').createEl('tr');
      totalRow.createEl('td', { text: `🟰 ${isRu ? 'Баланс' : 'Balance'}` });
      if (hasBudget) totalRow.createEl('td', { text: yearPlanBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      const balCell = totalRow.createEl('td', { text: yearActualBalance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      balCell.classList.add(yearActualBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
      if (hasBudget) totalRow.createEl('td');
      totalRow.createEl('td');
    }

    // ═══ ROW 2: Compare bars (left) + Income/Expense trend chart (right) ═══
    const row2 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // Left: compare bars Plan vs Actual
    const barsBlock = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = barsBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? (hasBudget ? 'План / Факт' : 'По категориям') : (hasBudget ? 'Plan vs Actual' : 'By Category')}` });
      const sections: [string, string, number, number][] = [
        ['💵', isRu ? 'Доходы' : 'Income', yearPlan.income, yearActual.income],
        ['🏠', isRu ? 'Обязат.' : 'Fixed', yearPlan.fixed, yearActual.fixed],
        ['🛒', isRu ? 'Перемен.' : 'Variable', yearPlan.variable, yearActual.variable],
        ['💳', isRu ? 'Долги' : 'Debts', yearPlan.debts, yearActual.debts],
        ['🏦', isRu ? 'Наколл.' : 'Savings', yearPlan.savings, yearActual.savings],
      ];
      const maxVal = Math.max(...sections.map(s => Math.max(s[2], s[3])), 1);

      for (const [icon, label, planned, actual] of sections) {
        const wrap = barsBlock.createDiv({ cls: 'planner-finance-compare-row' });
        wrap.createDiv({ cls: 'planner-finance-compare-label', text: `${icon} ${label}` });
        const barsWrap = wrap.createDiv({ cls: 'planner-finance-compare-bars' });
        if (hasBudget) {
          const planBar = barsWrap.createDiv({ cls: 'planner-finance-compare-bar planner-finance-bar-plan' });
          planBar.style.setProperty('--bar-width', `${Math.round((planned / maxVal) * 100)}%`);
          planBar.createSpan({ text: planned.toLocaleString(), cls: 'planner-finance-bar-text' });
        }
        const actBar = barsWrap.createDiv({ cls: 'planner-finance-compare-bar planner-finance-bar-actual' });
        actBar.style.setProperty('--bar-width', `${Math.round((actual / maxVal) * 100)}%`);
        actBar.createSpan({ text: actual.toLocaleString(), cls: 'planner-finance-bar-text' });
      }
      if (hasBudget) {
        const legend = barsBlock.createDiv({ cls: 'planner-finance-legend' });
        legend.createSpan({ cls: 'planner-finance-legend-plan', text: isRu ? '■ План' : '■ Plan' });
        legend.createSpan({ cls: 'planner-finance-legend-actual', text: isRu ? '■ Факт' : '■ Actual' });
      }
    }

    // Right: Income vs Expenses trend chart
    if (sortedMonths.length > 0) {
      const chartBlock = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = chartBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📈 ${isRu ? 'Тренд доходов и расходов' : 'Income & Expense Trend'}` });
      const chartEl = chartBlock.createDiv({ cls: 'planner-yearly-chart planner-finance-dual-chart' });

      const monthData = sortedMonths.map(m => {
        const act = monthActuals.get(m) || monthBudgetActuals.get(m) || { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
        return { month: m, income: act.income, expenses: act.fixed + act.variable + act.debts + act.savings };
      });
      const maxVal = Math.max(...monthData.flatMap(d => [d.income, d.expenses]), 1);

      for (const md of monthData) {
        const barGroup = chartEl.createDiv({ cls: 'planner-yearly-chart-bar-group' });
        const incBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-income' });
        incBar.style.setProperty('--bar-height', `${Math.round((md.income / maxVal) * 100)}%`);
        incBar.setAttribute('aria-label', `${isRu ? 'Доход' : 'Income'}: ${md.income.toLocaleString()}`);
        const expBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-expense' });
        expBar.style.setProperty('--bar-height', `${Math.round((md.expenses / maxVal) * 100)}%`);
        expBar.setAttribute('aria-label', `${isRu ? 'Расход' : 'Expense'}: ${md.expenses.toLocaleString()}`);
        barGroup.createDiv({ cls: 'planner-yearly-chart-label', text: monthNames[md.month - 1].substring(0, 3) });
      }
      const legend = chartBlock.createDiv({ cls: 'planner-finance-legend' });
      legend.createSpan({ cls: 'planner-finance-legend-income', text: isRu ? '■ Доходы' : '■ Income' });
      legend.createSpan({ cls: 'planner-finance-legend-expense', text: isRu ? '■ Расходы' : '■ Expenses' });
    }

    // ═══ ROW 3: Variable by category (left) + Fixed by category (right) — from daily data ═══
    if (hasDaily) {
      const varCatMap = new Map<string, number>();
      const fixCatMap = new Map<string, number>();
      for (const block of allDailyFin) {
        const data = this.parseDailyFinanceData(block);
        for (const v of data.variable) {
          const cat = v.category || (isRu ? 'Другое' : 'Other');
          varCatMap.set(cat, (varCatMap.get(cat) || 0) + v.amount);
        }
        for (const f of data.fixed) {
          const cat = f.category || (isRu ? 'Другое' : 'Other');
          fixCatMap.set(cat, (fixCatMap.get(cat) || 0) + f.amount);
        }
      }

      if (varCatMap.size > 0 || fixCatMap.size > 0) {
        const row3 = dashboard.createDiv({ cls: 'planner-weekly-row' });

        if (varCatMap.size > 0) {
          const catBlock2 = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr = catBlock2.createDiv({ cls: 'planner-weekly-block-header' });
          hdr.createEl('h4', { text: `🛒 ${isRu ? 'Переменные по категориям' : 'Variable by Category'}` });
          const sorted = [...varCatMap.entries()].sort((a, b) => b[1] - a[1]);
          const maxV = sorted[0][1];
          const catTotal = sorted.reduce((s, [, v]) => s + v, 0);
          const tbl = catBlock2.createEl('table', { cls: 'planner-summary-table' });
          const th = tbl.createEl('thead').createEl('tr');
          th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
          th.createEl('th', { text: '%' });
          th.createEl('th', { text: '' });
          const tb = tbl.createEl('tbody');
          for (const [cat, amount] of sorted) {
            const tr = tb.createEl('tr');
            tr.createEl('td', { text: cat });
            tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: `${Math.round((amount / catTotal) * 100)}%`, cls: 'planner-summary-number' });
            const barCell = tr.createEl('td');
            const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
            bar.addClass('planner-chart-bar-fixed');
            const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
            fill.style.setProperty('--bar-width', `${Math.round((amount / maxV) * 100)}%`);
            fill.addClass('planner-fill-accent');
          }
          const totalRow = tbl.createEl('tfoot').createEl('tr');
          totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
          totalRow.createEl('td', { text: catTotal.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalRow.createEl('td', { text: '100%', cls: 'planner-summary-number' });
          totalRow.createEl('td');
        }

        if (fixCatMap.size > 0) {
          const fixBlock = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr = fixBlock.createDiv({ cls: 'planner-weekly-block-header' });
          hdr.createEl('h4', { text: `🏠 ${isRu ? 'Обязательные по категориям' : 'Fixed by Category'}` });
          const sorted = [...fixCatMap.entries()].sort((a, b) => b[1] - a[1]);
          const maxV = sorted[0][1];
          const fixTotal = sorted.reduce((s, [, v]) => s + v, 0);
          const tbl = fixBlock.createEl('table', { cls: 'planner-summary-table' });
          const th = tbl.createEl('thead').createEl('tr');
          th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
          th.createEl('th', { text: '%' });
          th.createEl('th', { text: '' });
          const tb = tbl.createEl('tbody');
          for (const [cat, amount] of sorted) {
            const tr = tb.createEl('tr');
            tr.createEl('td', { text: cat });
            tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: `${Math.round((amount / fixTotal) * 100)}%`, cls: 'planner-summary-number' });
            const barCell = tr.createEl('td');
            const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
            bar.addClass('planner-chart-bar-fixed');
            const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
            fill.style.setProperty('--bar-width', `${Math.round((amount / maxV) * 100)}%`);
            fill.addClass('planner-fill-accent');
          }
          const totalRow = tbl.createEl('tfoot').createEl('tr');
          totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
          totalRow.createEl('td', { text: fixTotal.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
          totalRow.createEl('td', { text: '100%', cls: 'planner-summary-number' });
          totalRow.createEl('td');
        }
      }

      // ═══ ROW 4: Balance trend by month (cumulative) ═══
      if (sortedMonths.length > 1) {
        const row4 = dashboard.createDiv({ cls: 'planner-weekly-block' });
        const hdr = row4.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `📈 ${isRu ? 'Накопительный баланс по месяцам' : 'Cumulative Balance by Month'}` });
        const chartEl = row4.createDiv({ cls: 'planner-yearly-chart' });
        let cumulative = 0;
        const balData = sortedMonths.map(m => {
          const act = monthActuals.get(m) || monthBudgetActuals.get(m) || { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
          const bal = act.income - (act.fixed + act.variable + act.debts + act.savings);
          cumulative += bal;
          return { month: m, balance: cumulative };
        });
        const maxBal = Math.max(...balData.map(d => Math.abs(d.balance)), 1);
        for (const bd of balData) {
          const barWrap = chartEl.createDiv({ cls: 'planner-yearly-chart-bar-wrap' });
          const pct = Math.round((Math.abs(bd.balance) / maxBal) * 100);
          const bar = barWrap.createDiv({ cls: 'planner-yearly-chart-bar' });
          bar.style.setProperty('--bar-height', `${pct}%`);
          bar.addClass(bd.balance >= 0 ? 'planner-fill-positive' : 'planner-fill-negative');
          bar.setAttribute('aria-label', `${monthNames[bd.month - 1]}: ${bd.balance.toLocaleString()}`);
          barWrap.createDiv({ cls: 'planner-yearly-chart-label', text: monthNames[bd.month - 1].substring(0, 3) });
        }
      }

      // ═══ ROW 5: Top expenses ═══
      const allExpenses: { day: string; category: string; description: string; amount: number }[] = [];
      for (const block of allDailyFin) {
        const data = this.parseDailyFinanceData(block);
        for (const v of data.variable) {
          if (v.amount > 0) allExpenses.push({ day: block.day!, category: v.category || (isRu ? 'Другое' : 'Other'), description: v.description || '', amount: v.amount });
        }
        for (const f of data.fixed) {
          if (f.amount > 0) allExpenses.push({ day: block.day!, category: `🏠 ${f.category || ''}`, description: '', amount: f.amount });
        }
      }
      if (allExpenses.length > 0) {
        allExpenses.sort((a, b) => b.amount - a.amount);
        const top = allExpenses.slice(0, 15);
        const row5 = dashboard.createDiv({ cls: 'planner-weekly-row' });
        const topBlock = row5.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
        const hdr = topBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `🔝 ${isRu ? 'Топ-15 расходов за год' : 'Top 15 Expenses'}` });
        const tbl = topBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Дата' : 'Date' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Описание' : 'Description' });
        th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
        const tb = tbl.createEl('tbody');
        for (const exp of top) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: exp.day.substring(5), cls: 'planner-clickable' }).addEventListener('click', () => this.navigateToDay(exp.day));
          tr.createEl('td', { text: exp.category });
          tr.createEl('td', { text: exp.description || '—' });
          tr.createEl('td', { text: exp.amount.toLocaleString(), cls: 'planner-summary-number' });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ══ FINANCE MODE — Separate Year→Month→Week→Day navigation
  // ═══════════════════════════════════════════════════════════

  /** Main finance mode content renderer */
  private renderFinanceContent() {
    const { level } = this.nav;
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    if (level === 'year' && this.nav.year) {
      this.renderYearlyFinanceDashboard();
    } else if (level === 'month' && this.nav.year && this.nav.month) {
      this.renderMonthlyFinanceDashboard();
    } else if (level === 'week' && this.nav.year && this.nav.week) {
      this.renderWeeklyFinanceSummary();
    } else if (level === 'day' && this.nav.day) {
      this.renderDayFinanceView();
    } else {
      // Root level — show years
      this.contentArea.createEl('p', {
        text: isRu ? 'Выберите год для просмотра финансов' : 'Select a year to view finances',
        cls: 'planner-weekly-no-data',
      });
    }
  }

  /** Get daily-finance blocks for a date range */
  private getFinanceBlocksForRange(startDate: string, endDate: string): PlannerBlock[] {
    return this.plannerBlocks.filter(b =>
      b.template === 'daily-finance' && b.day && b.day >= startDate && b.day <= endDate
    );
  }

  /** Parse a daily-finance block into structured data */
  private parseDailyFinanceData(block: PlannerBlock): {
    income: { source: string; amount: number }[];
    fixed: { category: string; amount: number }[];
    variable: { category: string; description: string; amount: number }[];
    debts: { creditor: string; amount: number }[];
    savings: { goal: string; amount: number }[];
    totals: { income: number; fixed: number; variable: number; debts: number; savings: number };
  } {
    const empty = { income: [], fixed: [], variable: [], debts: [], savings: [], totals: { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 } };
    try {
      const schema = parseSchema(block.yaml);
      const expanded = schema.template ? expandTemplate(schema) : schema;
      const sections = (expanded as PlannerSchema).sections;
      if (!sections) return empty;

      const result = { ...empty, income: [] as Record<string, string | number | boolean>[], fixed: [] as Record<string, string | number | boolean>[], variable: [] as Record<string, string | number | boolean>[], debts: [] as Record<string, string | number | boolean>[], savings: [] as Record<string, string | number | boolean>[], totals: { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 } };

      if (sections.income) {
        for (const item of sections.income as Record<string, string | number | boolean>[]) {
          const amt = Number(item.amount) || 0;
          if (amt > 0) { result.income.push({ source: item.source || '', amount: amt }); result.totals.income += amt; }
        }
      }
      if (sections.fixed_expenses) {
        for (const item of sections.fixed_expenses as Record<string, string | number | boolean>[]) {
          const amt = Number(item.amount) || 0;
          if (amt > 0) { result.fixed.push({ category: item.category || '', amount: amt }); result.totals.fixed += amt; }
        }
      }
      if (sections.variable_expenses) {
        for (const item of sections.variable_expenses as Record<string, string | number | boolean>[]) {
          const amt = Number(item.amount) || 0;
          if (amt > 0) { result.variable.push({ category: item.category || '', description: item.description || '', amount: amt }); result.totals.variable += amt; }
        }
      }
      if (sections.debts) {
        for (const item of sections.debts as Record<string, string | number | boolean>[]) {
          const amt = Number(item.amount) || 0;
          if (amt > 0) { result.debts.push({ creditor: item.creditor || '', amount: amt }); result.totals.debts += amt; }
        }
      }
      if (sections.savings) {
        for (const item of sections.savings as Record<string, string | number | boolean>[]) {
          const amt = Number(item.amount) || 0;
          if (amt > 0) { result.savings.push({ goal: item.goal || '', amount: amt }); result.totals.savings += amt; }
        }
      }

      return result;
    } catch { return empty; }
  }

  /** Day-level finance view: show daily-finance block or create button */
  private renderDayFinanceView() {
    const day = this.nav.day!;
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const blocks = this.plannerBlocks.filter(b => b.template === 'daily-finance' && b.day === day);

    if (blocks.length === 0) {
      const createSection = this.contentArea.createDiv({ cls: 'planner-board-create-daily' });
      const createBtn = createSection.createEl('button', {
        text: isRu ? '💰 Создать запись финансов' : '💰 Create finance entry',
        cls: 'mod-cta',
      });
      createBtn.addEventListener('click', () => {
        void this.createDailyFinanceForDay(day);
      });
      return;
    }

    // Render finance blocks
    for (const block of blocks) {
      const card = this.contentArea.createDiv({ cls: 'planner-view-card' });
      const cardHeader = card.createDiv({ cls: 'planner-view-card-header' });
      cardHeader.createEl('h3', { text: block.title });
      const cardActions = cardHeader.createDiv({ cls: 'planner-view-card-actions' });
      const fileLink = cardActions.createEl('a', {
        text: block.file.replace(this.config.folder + '/', ''),
        cls: 'planner-view-card-file',
      });
      fileLink.addEventListener('click', (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(block.file, '');
      });
      const cardBody = card.createDiv({ cls: 'planner-view-card-body planner-boards-root' });
      createPlanner(block.yaml, cardBody, {
        suppressTitle: true,
        onAddItem: (subtableTitle: string) => {
          const section = this.resolveFinanceSubtableType(subtableTitle);
          if (section) this.addFinanceItemModal(block, section);
        },
        onDataChange: async (newYaml: string) => {
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        },
      });
    }
  }

  private resolveFinanceSubtableType(title: string): 'income' | 'fixed_expenses' | 'variable_expenses' | 'debts' | 'savings' | null {
    if (title.includes('Доход') || title.includes('Income')) return 'income';
    if (title.includes('Обязательные') || title.includes('Fixed')) return 'fixed_expenses';
    if (title.includes('Переменные') || title.includes('Variable')) return 'variable_expenses';
    if (title.includes('Долг') || title.includes('Debt')) return 'debts';
    if (title.includes('Накопл') || title.includes('Saving')) return 'savings';
    return null;
  }

  private addFinanceItemModal(block: PlannerBlock, section: 'income' | 'fixed_expenses' | 'variable_expenses' | 'debts' | 'savings') {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);

    const titles: Record<string, string> = {
      income: isRu ? 'Добавить доход' : 'Add income',
      fixed_expenses: isRu ? 'Добавить обязательный расход' : 'Add fixed expense',
      variable_expenses: isRu ? 'Добавить расход' : 'Add expense',
      debts: isRu ? 'Добавить платёж по долгу' : 'Add debt payment',
      savings: isRu ? 'Добавить накопление' : 'Add savings',
    };
    modal.titleEl.setText(titles[section]);
    const contentEl = modal.contentEl;

    const values: Record<string, string> = {};

    if (section === 'income') {
      new Setting(contentEl).setName(isRu ? 'Источник' : 'Source')
        .addText(txt => txt.setPlaceholder(isRu ? 'Зарплата' : 'Salary').onChange(v => values.source = v));
      new Setting(contentEl).setName(isRu ? 'Сумма' : 'Amount')
        .addText(txt => { txt.inputEl.type = 'number'; txt.setPlaceholder('0'); txt.onChange(v => values.amount = v); });
      new Setting(contentEl).setName(isRu ? 'Комментарий' : 'Comment')
        .addText(txt => txt.onChange(v => values.comment = v));
    } else if (section === 'fixed_expenses') {
      const categories = this.config.dictionaries['finance-fixed-categories'] || [];
      new Setting(contentEl).setName(isRu ? 'Категория' : 'Category')
        .addDropdown(dd => { dd.addOption('', '—'); categories.forEach(c => dd.addOption(c, c)); dd.onChange(v => values.category = v); });
      new Setting(contentEl).setName(isRu ? 'Описание' : 'Description')
        .addText(txt => txt.onChange(v => values.description = v));
      new Setting(contentEl).setName(isRu ? 'Сумма' : 'Amount')
        .addText(txt => { txt.inputEl.type = 'number'; txt.setPlaceholder('0'); txt.onChange(v => values.amount = v); });
    } else if (section === 'variable_expenses') {
      const categories = this.config.dictionaries['finance-variable-categories'] || [];
      new Setting(contentEl).setName(isRu ? 'Категория' : 'Category')
        .addDropdown(dd => { dd.addOption('', '—'); categories.forEach(c => dd.addOption(c, c)); dd.onChange(v => values.category = v); });
      new Setting(contentEl).setName(isRu ? 'Описание' : 'Description')
        .addText(txt => txt.onChange(v => values.description = v));
      new Setting(contentEl).setName(isRu ? 'Сумма' : 'Amount')
        .addText(txt => { txt.inputEl.type = 'number'; txt.setPlaceholder('0'); txt.onChange(v => values.amount = v); });
      new Setting(contentEl).setName(isRu ? 'Комментарий' : 'Comment')
        .addText(txt => txt.onChange(v => values.comment = v));
    } else if (section === 'debts') {
      new Setting(contentEl).setName(isRu ? 'Кредитор' : 'Creditor')
        .addText(txt => txt.setPlaceholder(isRu ? 'Банк' : 'Bank').onChange(v => values.creditor = v));
      new Setting(contentEl).setName(isRu ? 'Сумма' : 'Amount')
        .addText(txt => { txt.inputEl.type = 'number'; txt.setPlaceholder('0'); txt.onChange(v => values.amount = v); });
      new Setting(contentEl).setName(isRu ? 'Комментарий' : 'Comment')
        .addText(txt => txt.onChange(v => values.comment = v));
    } else if (section === 'savings') {
      new Setting(contentEl).setName(isRu ? 'Цель' : 'Goal')
        .addText(txt => txt.setPlaceholder(isRu ? 'Подушка' : 'Emergency fund').onChange(v => values.goal = v));
      new Setting(contentEl).setName(isRu ? 'Сумма' : 'Amount')
        .addText(txt => { txt.inputEl.type = 'number'; txt.setPlaceholder('0'); txt.onChange(v => values.amount = v); });
      new Setting(contentEl).setName(isRu ? 'Комментарий' : 'Comment')
        .addText(txt => txt.onChange(v => values.comment = v));
    }

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!values.amount || Number(values.amount) === 0) return;
        modal.close();
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections[section]) sections[section] = [];
          // Remove empty rows
          sections[section] = sections[section].filter((r: Record<string, string | number | boolean>) => {
            const vals = Object.values(r).filter(v => v !== '' && v !== 0 && v !== null && v !== undefined);
            return vals.length > 0;
          });

          // Build new row
          const newRow: Record<string, string | number | boolean> = {};
          if (section === 'income') {
            newRow.source = values.source || ''; newRow.amount = Number(values.amount) || 0; newRow.comment = values.comment || '';
          } else if (section === 'fixed_expenses') {
            newRow.category = values.category || ''; newRow.description = values.description || ''; newRow.amount = Number(values.amount) || 0;
          } else if (section === 'variable_expenses') {
            newRow.category = values.category || ''; newRow.description = values.description || ''; newRow.amount = Number(values.amount) || 0; newRow.comment = values.comment || '';
          } else if (section === 'debts') {
            newRow.creditor = values.creditor || ''; newRow.amount = Number(values.amount) || 0; newRow.comment = values.comment || '';
          } else if (section === 'savings') {
            newRow.goal = values.goal || ''; newRow.amount = Number(values.amount) || 0; newRow.comment = values.comment || '';
          }
          sections[section].push(newRow);
          // Add empty row at end for inline editing
          const emptyRow: Record<string, string | number | boolean> = {};
          for (const key of Object.keys(newRow)) emptyRow[key] = '';
          sections[section].push(emptyRow);

          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
        await this.refresh();
      }));
    modal.open();
  }

  /** Create a daily-finance file for a specific day */
  private async createDailyFinanceForDay(day: string) {
    const templates = this.plugin.getTemplates();
    const tmpl = templates['daily-finance'];
    if (!tmpl) return;
    const subFolder = this.config.templateFolders['daily-finance'] || 'daily-finance';
    const [dy, dm] = day.split('-');
    const monthName = getMonthNames()[parseInt(dm) - 1];
    const targetFolder = `${this.config.folder}/${subFolder}/${monthName} ${dy}`;
    const parts = targetFolder.split('/');
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
    }
    const month = `${dy}-${dm}`;
    let templateYaml = this.injectDictionaries(tmpl.generator(this.plugin.settings, month), 'daily-finance');
    templateYaml = templateYaml.replace(/month:\s*\S+/, `day: "${day}"`);

    // Merge template defaults (pre-filled creditors, etc.)
    if (this.config.templateDefaults['daily-finance']) {
      try {
        const defaultSchema = parseSchema(this.config.templateDefaults['daily-finance']);
        const defaultExpanded = defaultSchema.template ? expandTemplate(defaultSchema) : defaultSchema;
        const defaultSections = (defaultExpanded as PlannerSchema).sections;
        if (defaultSections) {
          const schema = parseSchema(templateYaml);
          const sections = (schema as PlannerSchema).sections || {};
          for (const [key, data] of Object.entries(defaultSections)) {
            if (Array.isArray(data) && data.length > 0) {
              const hasContent = data.some((row: Record<string, string | number | boolean>) => Object.values(row).some(v => v !== '' && v !== 0 && v !== false && v !== null && v !== undefined));
              if (hasContent) sections[key] = data;
            }
          }
          (schema as PlannerSchema).sections = sections;
          templateYaml = serializeSchema(schema);
        }
      } catch { /* use default template */ }
    }

    const content = '```planner\n' + templateYaml + '\n```\n';
    let fileName = `${targetFolder}/${day}-finance.planner`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = `${targetFolder}/${day}-finance ${counter}.planner`;
      counter++;
    }
    await this.app.vault.create(fileName, content);
    new Notice(t('notice.plannerCreated', { name: fileName }));
    await this.refresh();
  }

  /** Weekly finance aggregation dashboard */
  private renderWeeklyFinanceSummary() {
    const year = this.nav.year!;
    const week = this.nav.week!;
    const days = getDaysInWeek(year, week);
    const startDate = days[0].date;
    const endDate = days[6].date;
    const financeBlocks = this.getFinanceBlocksForRange(startDate, endDate);
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    const wStart = new Date(startDate);
    const wEnd = new Date(endDate);
    const wLabel = `${wStart.getDate()} ${getMonthShort()[wStart.getMonth()]} — ${wEnd.getDate()} ${getMonthShort()[wEnd.getMonth()]}`;
    dashboard.createEl('h3', { text: `💰 ${isRu ? 'Финансы за неделю' : 'Weekly Finance'}: ${wLabel}` });

    if (financeBlocks.length === 0) {
      dashboard.createEl('p', {
        text: isRu
          ? 'Нет финансовых записей за эту неделю. Создайте ежедневные финансовые записи для отслеживания расходов.'
          : 'No finance entries for this week. Create daily finance entries to track spending.',
        cls: 'planner-weekly-no-data',
      });
      // Show budget plan summary if available for this month
      const weekMonth = startDate.substring(0, 7);
      const finPlanBlocks = this.plannerBlocks.filter(b => b.template === 'finance-planner' && b.month === weekMonth);
      if (finPlanBlocks.length > 0) {
        const budgetData = this.parseFinanceBlock(finPlanBlocks[0]);
        const planIncome = budgetData.totals.income.planned;
        const planExpenses = budgetData.totals.fixed.planned + budgetData.totals.variable.planned + budgetData.totals.debts.planned + budgetData.totals.savings.planned;
        const planBalance = planIncome - planExpenses;
        const summaryBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
        const hdr = summaryBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `📋 ${isRu ? 'Бюджет на месяц' : 'Monthly Budget'}` });
        const budgetStats = summaryBlock.createDiv({ cls: 'planner-monthly-stats' });
        for (const [lbl, val, cls] of [
          [isRu ? 'Доходы (план)' : 'Income (plan)', planIncome.toLocaleString(), ''],
          [isRu ? 'Расходы (план)' : 'Expenses (plan)', planExpenses.toLocaleString(), ''],
          [isRu ? 'Баланс (план)' : 'Balance (plan)', planBalance.toLocaleString(), planBalance >= 0 ? 'planner-summary-good' : 'planner-summary-bad'],
        ] as [string, string, string][]) {
          const card = budgetStats.createDiv({ cls: 'planner-stat-card' });
          const valEl = card.createDiv({ cls: 'planner-stat-value', text: val });
          if (cls) valEl.classList.add(cls);
          card.createDiv({ cls: 'planner-stat-label', text: lbl });
        }
      }
      return;
    }

    // Parse all daily finance data
    type DayFin = { day: string; label: string; data: ReturnType<typeof this.parseDailyFinanceData> };
    const allDays: DayFin[] = [];
    let weekTotals = { income: 0, fixed: 0, variable: 0, debts: 0, savings: 0 };
    for (const block of financeBlocks) {
      const data = this.parseDailyFinanceData(block);
      const d = new Date(block.day! + 'T00:00:00');
      allDays.push({ day: block.day!, label: getDayNames()[d.getDay()], data });
      weekTotals.income += data.totals.income;
      weekTotals.fixed += data.totals.fixed;
      weekTotals.variable += data.totals.variable;
      weekTotals.debts += data.totals.debts;
      weekTotals.savings += data.totals.savings;
    }
    const totalExpenses = weekTotals.fixed + weekTotals.variable + weekTotals.debts + weekTotals.savings;
    const balance = weekTotals.income - totalExpenses;

    // Stat cards
    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    for (const [lbl, val, cls] of [
      [isRu ? 'Доходы' : 'Income', weekTotals.income.toLocaleString(), ''],
      [isRu ? 'Расходы' : 'Expenses', totalExpenses.toLocaleString(), ''],
      [isRu ? 'Баланс' : 'Balance', balance.toLocaleString(), balance >= 0 ? 'planner-summary-good' : 'planner-summary-bad'],
      [isRu ? 'Дней' : 'Days', String(allDays.length), ''],
    ] as [string, string, string][]) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      const valEl = card.createDiv({ cls: 'planner-stat-value', text: val });
      if (cls) valEl.classList.add(cls);
      card.createDiv({ cls: 'planner-stat-label', text: lbl });
    }

    // Budget plan for context (from finance-planner for this month)
    const weekMonth = startDate.substring(0, 7);
    const finPlanBlocks = this.plannerBlocks.filter(b => b.template === 'finance-planner' && b.month === weekMonth);
    const hasBudget = finPlanBlocks.length > 0;
    const budgetData = hasBudget ? this.parseFinanceBlock(finPlanBlocks[0]) : null;

    // ROW 1: Summary table (left) + Compare bars (right)
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // Left: summary table by category
    const summaryBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = summaryBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'Сводка за неделю' : 'Weekly Summary'}` });
      const tbl = summaryBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
      th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
      if (hasBudget) th.createEl('th', { text: isRu ? 'Бюджет/мес' : 'Budget/mo' });
      th.createEl('th', { text: '%' });
      const tb = tbl.createEl('tbody');

      const catRows: [string, string, number][] = [
        ['💵', isRu ? 'Доходы' : 'Income', weekTotals.income],
        ['🏠', isRu ? 'Обязательные' : 'Fixed', weekTotals.fixed],
        ['🛒', isRu ? 'Переменные' : 'Variable', weekTotals.variable],
        ['💳', isRu ? 'Долги' : 'Debts', weekTotals.debts],
        ['🏦', isRu ? 'Накопления' : 'Savings', weekTotals.savings],
      ];
      const budgetPlans = budgetData ? [
        budgetData.totals.income.planned,
        budgetData.totals.fixed.planned,
        budgetData.totals.variable.planned,
        budgetData.totals.debts.planned,
        budgetData.totals.savings.planned,
      ] : [0, 0, 0, 0, 0];
      for (let idx = 0; idx < catRows.length; idx++) {
        const [icon, label, amount] = catRows[idx];
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: `${icon} ${label}` });
        tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
        if (hasBudget) {
          tr.createEl('td', { text: budgetPlans[idx].toLocaleString(), cls: 'planner-summary-number' });
          const pct = budgetPlans[idx] > 0 ? Math.round((amount / budgetPlans[idx]) * 100) : 0;
          const pctCell = tr.createEl('td', { text: `${pct}%`, cls: 'planner-summary-number' });
          pctCell.classList.add(idx === 0 ? (pct >= 100 ? 'planner-summary-good' : '') : (pct > 100 ? 'planner-summary-bad' : 'planner-summary-good'));
        } else {
          const total = weekTotals.income || 1;
          tr.createEl('td', { text: idx === 0 ? '—' : `${Math.round((amount / total) * 100)}%`, cls: 'planner-summary-number' });
        }
      }
      const totalRow = tbl.createEl('tfoot').createEl('tr');
      totalRow.createEl('td', { text: `🟰 ${isRu ? 'Баланс' : 'Balance'}` });
      const balCell = totalRow.createEl('td', { text: balance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      balCell.classList.add(balance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
      if (hasBudget) totalRow.createEl('td');
      totalRow.createEl('td');
    }

    // Right: compare bars by category
    const barsBlock = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = barsBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'По категориям' : 'By Category'}` });
      const sections: [string, string, number][] = [
        ['💵', isRu ? 'Доходы' : 'Income', weekTotals.income],
        ['🏠', isRu ? 'Обязат.' : 'Fixed', weekTotals.fixed],
        ['🛒', isRu ? 'Перемен.' : 'Variable', weekTotals.variable],
        ['💳', isRu ? 'Долги' : 'Debts', weekTotals.debts],
        ['🏦', isRu ? 'Наколл.' : 'Savings', weekTotals.savings],
      ];
      const maxVal = Math.max(...sections.map(s => s[2]), 1);

      for (const [icon, label, amount] of sections) {
        const wrap = barsBlock.createDiv({ cls: 'planner-finance-compare-row' });
        wrap.createDiv({ cls: 'planner-finance-compare-label', text: `${icon} ${label}` });
        const barsWrap = wrap.createDiv({ cls: 'planner-finance-compare-bars' });
        const actBar = barsWrap.createDiv({ cls: 'planner-finance-compare-bar planner-finance-bar-actual' });
        actBar.style.setProperty('--bar-width', `${Math.round((amount / maxVal) * 100)}%`);
        actBar.createSpan({ text: amount.toLocaleString(), cls: 'planner-finance-bar-text' });
      }
    }

    // ROW 2: Daily breakdown table (left) + Daily spending chart (right)
    const row2 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // Left: day-by-day table
    const dayTable = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = dayTable.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📋 ${isRu ? 'По дням' : 'By Day'}` });
      const tbl = dayTable.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'День' : 'Day' });
      th.createEl('th', { text: '💵' });
      th.createEl('th', { text: '🏠' });
      th.createEl('th', { text: '🛒' });
      th.createEl('th', { text: '💳' });
      th.createEl('th', { text: '🏦' });
      th.createEl('th', { text: '🟰' });
      const tb = tbl.createEl('tbody');
      for (const d of allDays) {
        const t = d.data.totals;
        const dayExp = t.fixed + t.variable + t.debts + t.savings;
        const dayBal = t.income - dayExp;
        const tr = tb.createEl('tr');
        const dayCell = tr.createEl('td', { text: `${d.label} ${d.day.substring(8)}`, cls: 'planner-clickable' });
        dayCell.addEventListener('click', () => this.navigateToDay(d.day));
        tr.createEl('td', { text: t.income > 0 ? t.income.toLocaleString() : '—', cls: 'planner-summary-number' });
        tr.createEl('td', { text: t.fixed > 0 ? t.fixed.toLocaleString() : '—', cls: 'planner-summary-number' });
        tr.createEl('td', { text: t.variable > 0 ? t.variable.toLocaleString() : '—', cls: 'planner-summary-number' });
        tr.createEl('td', { text: t.debts > 0 ? t.debts.toLocaleString() : '—', cls: 'planner-summary-number' });
        tr.createEl('td', { text: t.savings > 0 ? t.savings.toLocaleString() : '—', cls: 'planner-summary-number' });
        const balCell = tr.createEl('td', { text: dayBal.toLocaleString(), cls: 'planner-summary-number' });
        balCell.classList.add(dayBal >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
      }
      const totalRow = tbl.createEl('tfoot').createEl('tr');
      totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total' });
      totalRow.createEl('td', { text: weekTotals.income.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      totalRow.createEl('td', { text: weekTotals.fixed.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      totalRow.createEl('td', { text: weekTotals.variable.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      totalRow.createEl('td', { text: weekTotals.debts.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      totalRow.createEl('td', { text: weekTotals.savings.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      const balTotal = totalRow.createEl('td', { text: balance.toLocaleString(), cls: 'planner-summary-number planner-summary-total' });
      balTotal.classList.add(balance >= 0 ? 'planner-summary-good' : 'planner-summary-bad');
    }

    // Right: daily spending bar chart
    const chartBlock = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = chartBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📈 ${isRu ? 'Расходы по дням' : 'Daily Spending'}` });
      const chartEl = chartBlock.createDiv({ cls: 'planner-yearly-chart planner-finance-dual-chart' });
      const dayChartData = allDays.map(d => {
        const t = d.data.totals;
        return { label: d.day.substring(8), income: t.income, expenses: t.fixed + t.variable + t.debts + t.savings };
      });
      const maxVal = Math.max(...dayChartData.flatMap(d => [d.income, d.expenses]), 1);
      for (const dc of dayChartData) {
        const barGroup = chartEl.createDiv({ cls: 'planner-yearly-chart-bar-group' });
        const incBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-income' });
        incBar.style.setProperty('--bar-height', `${Math.round((dc.income / maxVal) * 100)}%`);
        incBar.setAttribute('aria-label', `${isRu ? 'Доход' : 'Income'}: ${dc.income.toLocaleString()}`);
        const expBar = barGroup.createDiv({ cls: 'planner-yearly-chart-bar planner-finance-bar-expense' });
        expBar.style.setProperty('--bar-height', `${Math.round((dc.expenses / maxVal) * 100)}%`);
        expBar.setAttribute('aria-label', `${isRu ? 'Расход' : 'Expense'}: ${dc.expenses.toLocaleString()}`);
        barGroup.createDiv({ cls: 'planner-yearly-chart-label', text: dc.label });
      }
      const legend = chartBlock.createDiv({ cls: 'planner-finance-legend' });
      legend.createSpan({ cls: 'planner-finance-legend-income', text: isRu ? '■ Доходы' : '■ Income' });
      legend.createSpan({ cls: 'planner-finance-legend-expense', text: isRu ? '■ Расходы' : '■ Expenses' });
    }

    // ROW 3: Variable expenses by category (with progress bars)
    {
      const catMap = new Map<string, number>();
      for (const d of allDays) {
        for (const v of d.data.variable) {
          const cat = v.category || (isRu ? 'Другое' : 'Other');
          catMap.set(cat, (catMap.get(cat) || 0) + v.amount);
        }
      }
      if (catMap.size > 0) {
        const row3 = dashboard.createDiv({ cls: 'planner-weekly-row' });
        const catBlock = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
        const hdr = catBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `🛒 ${isRu ? 'Переменные по категориям' : 'Variable by Category'}` });
        const sorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
        const maxVal = sorted[0][1];
        const catTotal = sorted.reduce((s, [, v]) => s + v, 0);
        const tbl = catBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
        th.createEl('th', { text: '%' });
        th.createEl('th', { text: '' });
        const tb = tbl.createEl('tbody');
        for (const [cat, amount] of sorted) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: cat });
          tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
          tr.createEl('td', { text: `${Math.round((amount / catTotal) * 100)}%`, cls: 'planner-summary-number' });
          const barCell = tr.createEl('td');
          const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
          bar.addClass('planner-chart-bar-fixed');
          const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
          fill.style.setProperty('--bar-width', `${Math.round((amount / maxVal) * 100)}%`);
          fill.addClass('planner-fill-accent');
        }

        // Also show fixed expenses breakdown if any
        const fixedMap = new Map<string, number>();
        for (const d of allDays) {
          for (const f of d.data.fixed) {
            const cat = f.category || (isRu ? 'Другое' : 'Other');
            fixedMap.set(cat, (fixedMap.get(cat) || 0) + f.amount);
          }
        }
        if (fixedMap.size > 0) {
          const fixBlock = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
          const hdr2 = fixBlock.createDiv({ cls: 'planner-weekly-block-header' });
          hdr2.createEl('h4', { text: `🏠 ${isRu ? 'Обязательные по категориям' : 'Fixed by Category'}` });
          const fixSorted = [...fixedMap.entries()].sort((a, b) => b[1] - a[1]);
          const fixMax = fixSorted[0][1];
          const fixTotal = fixSorted.reduce((s, [, v]) => s + v, 0);
          const tbl2 = fixBlock.createEl('table', { cls: 'planner-summary-table' });
          const th2 = tbl2.createEl('thead').createEl('tr');
          th2.createEl('th', { text: isRu ? 'Категория' : 'Category' });
          th2.createEl('th', { text: isRu ? 'Сумма' : 'Amount' });
          th2.createEl('th', { text: '%' });
          th2.createEl('th', { text: '' });
          const tb2 = tbl2.createEl('tbody');
          for (const [cat, amount] of fixSorted) {
            const tr = tb2.createEl('tr');
            tr.createEl('td', { text: cat });
            tr.createEl('td', { text: amount.toLocaleString(), cls: 'planner-summary-number' });
            tr.createEl('td', { text: `${Math.round((amount / fixTotal) * 100)}%`, cls: 'planner-summary-number' });
            const barCell = tr.createEl('td');
            const bar = barCell.createDiv({ cls: 'planner-summary-progress-bar' });
            bar.addClass('planner-chart-bar-fixed');
            const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
            fill.style.setProperty('--bar-width', `${Math.round((amount / fixMax) * 100)}%`);
            fill.addClass('planner-fill-accent');
          }
        }
      }
    }
  }

  /** Parse all goal-tracker blocks and extract goals */
  private parseGoalBlocks(): { objective: string; key_result: string; quarter: string; status: string; target: number; current: number; progress: number }[] {
    const goalBlocks = this.plannerBlocks.filter(b => b.template === 'goal-tracker');
    const goals: { objective: string; key_result: string; quarter: string; status: string; target: number; current: number; progress: number }[] = [];
    for (const block of goalBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const data = (expanded as PlannerSchema).data as Record<string, string | number | boolean>[] | undefined;
        if (!data) continue;
        for (const row of data) {
          if (!row.objective && !row.key_result) continue;
          const target = Number(row.target) || 100;
          const current = Number(row.current) || 0;
          const progress = target > 0 ? Math.round((current / target) * 100) : 0;
          goals.push({
            objective: row.objective || '',
            key_result: row.key_result || '',
            quarter: row.quarter || 'Q1',
            status: row.status || '',
            target,
            current,
            progress,
          });
        }
      } catch { /* skip */ }
    }
    return goals;
  }

  /** Render yearly OKR goals dashboard (tab view) */
  private renderYearlyGoalsDashboard() {
    const year = this.nav.year!;
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const goals = this.parseGoalBlocks();

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `🎯 ${isRu ? 'Цели OKR' : 'OKR Goals'}: ${year}` });

    if (goals.length === 0) {
      dashboard.createEl('p', { text: isRu ? 'Нет целей. Создайте goal-tracker на доске.' : 'No goals. Create a goal-tracker on the board.', cls: 'planner-weekly-no-data' });
      return;
    }

    // ROW 0: Stat cards
    const totalGoals = goals.length;
    const achieved = goals.filter(g => g.status.includes('✅')).length;
    const inProgress = goals.filter(g => g.status.includes('🔵')).length;
    const avgProgress = totalGoals > 0 ? Math.round(goals.reduce((s, g) => s + g.progress, 0) / totalGoals) : 0;

    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    for (const [lbl, val] of [
      [isRu ? 'Всего целей' : 'Total Goals', String(totalGoals)],
      [isRu ? 'Достигнуто' : 'Achieved', `${achieved}/${totalGoals}`],
      [isRu ? 'В процессе' : 'In Progress', String(inProgress)],
      [isRu ? 'Ср. прогресс' : 'Avg Progress', `${avgProgress}%`],
    ]) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      card.createDiv({ cls: 'planner-stat-value', text: String(val) });
      card.createDiv({ cls: 'planner-stat-label', text: String(lbl) });
    }

    // Overall progress bar
    const progressWrap = dashboard.createDiv({ cls: 'planner-goals-overall-progress' });
    progressWrap.createSpan({ text: `${isRu ? 'Общий прогресс' : 'Overall Progress'}: ${avgProgress}%` });
    const bar = progressWrap.createDiv({ cls: 'planner-summary-progress-bar' });
    bar.addClass('planner-progress-bar-tall');
    const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
    fill.style.setProperty('--bar-width', `${avgProgress}%`);
    fill.addClass(avgProgress >= 70 ? 'planner-fill-success' : avgProgress >= 30 ? 'planner-fill-accent' : 'planner-fill-error');

    // Group by quarter
    const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];
    for (const q of quarters) {
      const qGoals = goals.filter(g => g.quarter === q);
      if (qGoals.length === 0) continue;

      const qBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const qAchieved = qGoals.filter(g => g.status.includes('✅')).length;
      const qAvg = Math.round(qGoals.reduce((s, g) => s + g.progress, 0) / qGoals.length);

      const hdr = qBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `${q} — ${qGoals.length} ${isRu ? 'целей' : 'goals'} (${qAchieved} ✅, ${isRu ? 'прогресс' : 'progress'}: ${qAvg}%)` });

      const tbl = qBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Цель' : 'Objective' });
      th.createEl('th', { text: isRu ? 'Ключевой результат' : 'Key Result' });
      th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
      th.createEl('th', { text: isRu ? 'Цель' : 'Target' });
      th.createEl('th', { text: isRu ? 'Текущий' : 'Current' });
      th.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
      const tb = tbl.createEl('tbody');

      for (const g of qGoals) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: g.objective });
        tr.createEl('td', { text: g.key_result });
        tr.createEl('td', { text: g.status });
        tr.createEl('td', { text: String(g.target), cls: 'planner-summary-number' });
        tr.createEl('td', { text: String(g.current), cls: 'planner-summary-number' });
        const progCell = tr.createEl('td');
        const progBar = progCell.createDiv({ cls: 'planner-summary-progress-bar' });
        progBar.addClass('planner-progress-bar-inline');
        const progFill = progBar.createDiv({ cls: 'planner-summary-progress-fill' });
        progFill.style.setProperty('--bar-width', `${g.progress}%`);
        progFill.addClass(g.progress >= 70 ? 'planner-fill-success' : g.progress >= 30 ? 'planner-fill-accent' : 'planner-fill-error');
        progCell.createSpan({ text: ` ${g.progress}%`, cls: 'planner-summary-number' });
      }
    }

    // Linked tasks from daily planners
    this.renderGoalLinkedTasks(dashboard, goals, `${year}-01-01`, `${year}-12-31`);
  }

  /** Render monthly OKR goals dashboard (tab view) — shows current quarter */
  private renderMonthlyGoalsDashboard() {
    const year = this.nav.year!;
    const month = this.nav.month!;
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const monthNames = getMonthNames();
    const goals = this.parseGoalBlocks();

    // Determine current quarter
    const currentQuarter = `Q${Math.ceil(month / 3)}`;

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `🎯 ${isRu ? 'Цели' : 'Goals'}: ${monthNames[month - 1]} ${year} (${currentQuarter})` });

    const qGoals = goals.filter(g => g.quarter === currentQuarter);

    if (qGoals.length === 0) {
      dashboard.createEl('p', { text: isRu ? `Нет целей на ${currentQuarter}. Создайте goal-tracker на доске.` : `No goals for ${currentQuarter}. Create a goal-tracker.`, cls: 'planner-weekly-no-data' });
      return;
    }

    // Stat cards for quarter
    const totalGoals = qGoals.length;
    const achieved = qGoals.filter(g => g.status.includes('✅')).length;
    const inProgress = qGoals.filter(g => g.status.includes('🔵')).length;
    const avgProgress = Math.round(qGoals.reduce((s, g) => s + g.progress, 0) / totalGoals);

    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    for (const [lbl, val] of [
      [`${currentQuarter} ${isRu ? 'целей' : 'goals'}`, String(totalGoals)],
      [isRu ? 'Достигнуто' : 'Achieved', `${achieved}/${totalGoals}`],
      [isRu ? 'В процессе' : 'In Progress', String(inProgress)],
      [isRu ? 'Прогресс' : 'Progress', `${avgProgress}%`],
    ]) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      card.createDiv({ cls: 'planner-stat-value', text: String(val) });
      card.createDiv({ cls: 'planner-stat-label', text: String(lbl) });
    }

    // Goals table
    const tblBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
    const hdr = tblBlock.createDiv({ cls: 'planner-weekly-block-header' });
    hdr.createEl('h4', { text: `${currentQuarter} — ${isRu ? 'Цели' : 'Goals'}` });

    const tbl = tblBlock.createEl('table', { cls: 'planner-summary-table' });
    const th = tbl.createEl('thead').createEl('tr');
    th.createEl('th', { text: isRu ? 'Цель' : 'Objective' });
    th.createEl('th', { text: isRu ? 'Ключевой результат' : 'Key Result' });
    th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
    th.createEl('th', { text: isRu ? 'Цель' : 'Target' });
    th.createEl('th', { text: isRu ? 'Текущий' : 'Current' });
    th.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
    const tb = tbl.createEl('tbody');

    for (const g of qGoals) {
      const tr = tb.createEl('tr');
      tr.createEl('td', { text: g.objective });
      tr.createEl('td', { text: g.key_result });
      tr.createEl('td', { text: g.status });
      tr.createEl('td', { text: String(g.target), cls: 'planner-summary-number' });
      tr.createEl('td', { text: String(g.current), cls: 'planner-summary-number' });
      const progCell = tr.createEl('td');
      const progBar = progCell.createDiv({ cls: 'planner-summary-progress-bar' });
      progBar.addClass('planner-progress-bar-inline');
      const progFill = progBar.createDiv({ cls: 'planner-summary-progress-fill' });
      progFill.style.setProperty('--bar-width', `${g.progress}%`);
      progFill.addClass(g.progress >= 70 ? 'planner-fill-success' : g.progress >= 30 ? 'planner-fill-accent' : 'planner-fill-error');
      progCell.createSpan({ text: ` ${g.progress}%`, cls: 'planner-summary-number' });
    }

    // Also show all quarters summary for context
    const allGoals = goals.filter(g => g.quarter !== currentQuarter);
    if (allGoals.length > 0) {
      const otherBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const otherHdr = otherBlock.createDiv({ cls: 'planner-weekly-block-header' });
      otherHdr.createEl('h4', { text: isRu ? 'Другие кварталы' : 'Other Quarters' });
      const otherTbl = otherBlock.createEl('table', { cls: 'planner-summary-table' });
      const oTh = otherTbl.createEl('thead').createEl('tr');
      oTh.createEl('th', { text: isRu ? 'Квартал' : 'Quarter' });
      oTh.createEl('th', { text: isRu ? 'Целей' : 'Goals' });
      oTh.createEl('th', { text: isRu ? 'Достигнуто' : 'Achieved' });
      oTh.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
      const oTb = otherTbl.createEl('tbody');
      for (const q of ['Q1', 'Q2', 'Q3', 'Q4'].filter(q2 => q2 !== currentQuarter)) {
        const qg = goals.filter(g2 => g2.quarter === q);
        if (qg.length === 0) continue;
        const tr = oTb.createEl('tr');
        tr.createEl('td', { text: q });
        tr.createEl('td', { text: String(qg.length), cls: 'planner-summary-number' });
        tr.createEl('td', { text: String(qg.filter(g2 => g2.status.includes('✅')).length), cls: 'planner-summary-number' });
        const avg = Math.round(qg.reduce((s, g2) => s + g2.progress, 0) / qg.length);
        const progCell = tr.createEl('td');
        const progBar = progCell.createDiv({ cls: 'planner-summary-progress-bar' });
        progBar.addClass('planner-progress-bar-inline');
        const progFill = progBar.createDiv({ cls: 'planner-summary-progress-fill' });
        progFill.style.setProperty('--bar-width', `${avg}%`);
        progFill.addClass(avg >= 70 ? 'planner-fill-success' : avg >= 30 ? 'planner-fill-accent' : 'planner-fill-error');
        progCell.createSpan({ text: ` ${avg}%`, cls: 'planner-summary-number' });
      }
    }

    // Linked tasks from daily planners (current month)
    const monthPad = String(month).padStart(2, '0');
    const mStart = `${year}-${monthPad}-01`;
    const daysInMonth = new Date(year, month, 0).getDate();
    const mEnd = `${year}-${monthPad}-${String(daysInMonth).padStart(2, '0')}`;
    this.renderGoalLinkedTasks(dashboard, qGoals, mStart, mEnd);
  }

  /** Render linked tasks section for goals dashboard */
  private renderGoalLinkedTasks(
    container: HTMLElement,
    goals: { objective: string; key_result: string; quarter: string; status: string; target: number; current: number; progress: number }[],
    startDate: string, endDate: string,
  ) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    if (dailyBlocks.length === 0) return;

    // Collect all objective names for matching
    const objectiveNames = new Set(goals.map(g => g.objective).filter(Boolean));
    if (objectiveNames.size === 0) return;

    // Parse tasks linked to goals
    const linkedTasks: { day: string; task: string; goal: string; done: boolean; type: string }[] = [];
    for (const block of dailyBlocks) {
      const data = this.parseDailyData(block);
      for (const t of data.weeklyTasks) {
        if (t.goal) linkedTasks.push({ day: data.day, task: t.task, goal: t.goal, done: t.done, type: isRu ? 'Неделя' : 'Weekly' });
      }
      for (const t of data.monthlyTasks) {
        if (t.goal) linkedTasks.push({ day: data.day, task: t.task, goal: t.goal, done: t.done, type: isRu ? 'Месяц' : 'Monthly' });
      }
    }

    if (linkedTasks.length === 0) return;

    // Deduplicate tasks (same task name + goal = one entry, pick latest done status)
    const taskMap = new Map<string, { task: string; goal: string; done: boolean; type: string; days: string[] }>();
    for (const lt of linkedTasks) {
      const key = `${lt.task}::${lt.goal}`;
      if (!taskMap.has(key)) {
        taskMap.set(key, { task: lt.task, goal: lt.goal, done: lt.done, type: lt.type, days: [lt.day] });
      } else {
        const existing = taskMap.get(key)!;
        if (lt.done) existing.done = true;
        if (!existing.days.includes(lt.day)) existing.days.push(lt.day);
      }
    }

    // Group by goal
    const byGoal = new Map<string, typeof linkedTasks>();
    for (const [, entry] of taskMap) {
      if (!byGoal.has(entry.goal)) byGoal.set(entry.goal, []);
      byGoal.get(entry.goal)!.push({ day: entry.days[0], task: entry.task, goal: entry.goal, done: entry.done, type: entry.type });
    }

    const block = container.createDiv({ cls: 'planner-weekly-block' });
    const hdr = block.createDiv({ cls: 'planner-weekly-block-header' });
    const totalLinked = taskMap.size;
    const doneLinked = [...taskMap.values()].filter(t => t.done).length;
    hdr.createEl('h4', { text: `🔗 ${isRu ? 'Связанные задачи' : 'Linked Tasks'} (${doneLinked}/${totalLinked})` });

    for (const [goal, tasks] of byGoal) {
      const goalDiv = block.createDiv({ cls: 'planner-goal-linked-group' });
      goalDiv.createEl('strong', { text: `🎯 ${goal}` });
      const tbl = goalDiv.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: '✓' });
      th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
      th.createEl('th', { text: isRu ? 'Тип' : 'Type' });
      const tb = tbl.createEl('tbody');
      for (const t of tasks) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: t.done ? '✅' : '⬜' });
        tr.createEl('td', { text: t.task });
        tr.createEl('td', { text: t.type });
      }
    }
  }
  private parseProjectBlocks(): { task: string; assignee: string; status: string; priority: string; deadline: string; progress: number; project: string }[] {
    const projBlocks = this.plannerBlocks.filter(b => b.template === 'project-tracker');
    const tasks: { task: string; assignee: string; status: string; priority: string; deadline: string; progress: number; project: string }[] = [];
    for (const block of projBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const data = (expanded as PlannerSchema).data as Record<string, string | number | boolean>[] | undefined;
        const project = (expanded as PlannerSchema)['project'] || (expanded as PlannerSchema).title || '';
        if (!data) continue;
        for (const row of data) {
          if (!row.task) continue;
          tasks.push({
            task: row.task || '',
            assignee: row.assignee || '',
            status: row.status || '',
            priority: row.priority || '',
            deadline: row.deadline || '',
            progress: Number(row.progress) || 0,
            project: String(project),
          });
        }
      } catch { /* skip */ }
    }
    return tasks;
  }

  /** Render dedicated projects dashboard */
  private renderProjectsDashboard() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const { level } = this.nav;
    const allTasks = this.parseProjectBlocks();

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    const titleSuffix = level === 'year' ? String(this.nav.year) : `${getMonthNames()[this.nav.month! - 1]} ${this.nav.year}`;
    dashboard.createEl('h3', { text: `🚀 ${isRu ? 'Проекты' : 'Projects'}: ${titleSuffix}` });

    if (allTasks.length === 0) {
      dashboard.createEl('p', { text: isRu ? 'Нет проектов. Создайте project-tracker на доске.' : 'No projects. Create a project-tracker.', cls: 'planner-weekly-no-data' });
      return;
    }

    // Stat cards
    const totalTasks = allTasks.length;
    const doneTasks = allTasks.filter(t => t.status.includes('✅')).length;
    const inProgress = allTasks.filter(t => t.status.includes('🔵')).length;
    const avgProgress = totalTasks > 0 ? Math.round(allTasks.reduce((s, t) => s + t.progress, 0) / totalTasks) : 0;

    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    for (const [lbl, val] of [
      [isRu ? 'Всего задач' : 'Total Tasks', String(totalTasks)],
      [isRu ? 'Готово' : 'Done', `${doneTasks}/${totalTasks}`],
      [isRu ? 'В работе' : 'In Progress', String(inProgress)],
      [isRu ? 'Ср. прогресс' : 'Avg Progress', `${avgProgress}%`],
    ]) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      card.createDiv({ cls: 'planner-stat-value', text: String(val) });
      card.createDiv({ cls: 'planner-stat-label', text: String(lbl) });
    }

    // Group by project
    const byProject = new Map<string, typeof allTasks>();
    for (const t of allTasks) {
      const p = t.project || (isRu ? 'Без проекта' : 'No Project');
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push(t);
    }

    for (const [project, tasks] of byProject) {
      const pBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const pDone = tasks.filter(t => t.status.includes('✅')).length;
      const pAvg = Math.round(tasks.reduce((s, t) => s + t.progress, 0) / tasks.length);

      const hdr = pBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `${project} — ${pDone}/${tasks.length} ✅ (${pAvg}%)` });

      const tbl = pBlock.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
      th.createEl('th', { text: isRu ? 'Исполнитель' : 'Assignee' });
      th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
      th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
      th.createEl('th', { text: isRu ? 'Дедлайн' : 'Deadline' });
      th.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
      const tb = tbl.createEl('tbody');

      for (const t of tasks) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: t.task });
        tr.createEl('td', { text: t.assignee });
        tr.createEl('td', { text: t.status });
        tr.createEl('td', { text: t.priority });
        const deadlineCell = tr.createEl('td', { text: t.deadline });
        // Highlight overdue
        if (t.deadline && !t.status.includes('✅')) {
          const today = new Date().toISOString().substring(0, 10);
          if (t.deadline < today) deadlineCell.classList.add('planner-summary-bad');
        }
        const progCell = tr.createEl('td');
        const progBar = progCell.createDiv({ cls: 'planner-summary-progress-bar' });
        progBar.addClass('planner-progress-bar-inline');
        const progFill = progBar.createDiv({ cls: 'planner-summary-progress-fill' });
        progFill.style.setProperty('--bar-width', `${t.progress}%`);
        progCell.createSpan({ text: ` ${t.progress}%`, cls: 'planner-summary-number' });
      }
    }

    // Upcoming deadlines section (monthly level)
    if (level === 'month') {
      const monthPad = String(this.nav.month!).padStart(2, '0');
      const monthStart = `${this.nav.year}-${monthPad}-01`;
      const daysInMonth = new Date(this.nav.year!, this.nav.month!, 0).getDate();
      const monthEnd = `${this.nav.year}-${monthPad}-${String(daysInMonth).padStart(2, '0')}`;
      const upcoming = allTasks.filter(t => t.deadline >= monthStart && t.deadline <= monthEnd && !t.status.includes('✅'))
        .sort((a, b) => a.deadline.localeCompare(b.deadline));

      if (upcoming.length > 0) {
        const dlBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
        const hdr = dlBlock.createDiv({ cls: 'planner-weekly-block-header' });
        hdr.createEl('h4', { text: `⏰ ${isRu ? 'Дедлайны в этом месяце' : 'Deadlines This Month'}` });
        const tbl = dlBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Дедлайн' : 'Deadline' });
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Проект' : 'Project' });
        th.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
        const tb = tbl.createEl('tbody');
        const today = new Date().toISOString().substring(0, 10);
        for (const t of upcoming) {
          const tr = tb.createEl('tr');
          const dlCell = tr.createEl('td', { text: t.deadline.substring(5) });
          if (t.deadline < today) dlCell.classList.add('planner-summary-bad');
          tr.createEl('td', { text: t.task });
          tr.createEl('td', { text: t.project });
          tr.createEl('td', { text: `${t.progress}%`, cls: 'planner-summary-number' });
        }
      }
    }
  }

  /** Parse all reading-log blocks */
  private parseReadingBlocks(): { title: string; author: string; status: string; pages: number; read: number; progress: number; rating: number; notes: string }[] {
    const readBlocks = this.plannerBlocks.filter(b => b.template === 'reading-log');
    const books: { title: string; author: string; status: string; pages: number; read: number; progress: number; rating: number; notes: string }[] = [];
    for (const block of readBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const data = (expanded as PlannerSchema).data as Record<string, string | number | boolean>[] | undefined;
        if (!data) continue;
        for (const row of data) {
          if (!row.title) continue;
          const pages = Number(row.pages) || 0;
          const read = Number(row.read) || 0;
          books.push({
            title: row.title || '',
            author: row.author || '',
            status: row.status || '',
            pages,
            read,
            progress: pages > 0 ? Math.round((read / pages) * 100) : 0,
            rating: Number(row.rating) || 0,
            notes: row.notes || '',
          });
        }
      } catch { /* skip */ }
    }
    return books;
  }

  /** Render dedicated reading dashboard */
  private renderReadingDashboard() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const { level } = this.nav;
    const allBooks = this.parseReadingBlocks();

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    const titleSuffix = level === 'year' ? String(this.nav.year) : `${getMonthNames()[this.nav.month! - 1]} ${this.nav.year}`;
    dashboard.createEl('h3', { text: `📖 ${isRu ? 'Чтение' : 'Reading'}: ${titleSuffix}` });

    if (allBooks.length === 0) {
      dashboard.createEl('p', { text: isRu ? 'Нет книг. Создайте reading-log на доске.' : 'No books. Create a reading-log.', cls: 'planner-weekly-no-data' });
      return;
    }

    // Stat cards
    const totalBooks = allBooks.length;
    const finished = allBooks.filter(b => b.status.includes('✅')).length;
    const reading = allBooks.filter(b => b.status.includes('📖')).length;
    const ratedBooks = allBooks.filter(b => b.rating > 0);
    const avgRating = ratedBooks.length > 0 ? (ratedBooks.reduce((s, b) => s + b.rating, 0) / ratedBooks.length).toFixed(1) : '—';
    const totalPages = allBooks.reduce((s, b) => s + b.read, 0);

    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    for (const [lbl, val] of [
      [isRu ? 'Всего книг' : 'Total Books', String(totalBooks)],
      [isRu ? 'Прочитано' : 'Finished', String(finished)],
      [isRu ? 'Читаю' : 'Reading', String(reading)],
      [isRu ? 'Ср. оценка' : 'Avg Rating', String(avgRating)],
      [isRu ? 'Страниц' : 'Pages', totalPages.toLocaleString()],
    ]) {
      const card = statsRow.createDiv({ cls: 'planner-stat-card' });
      card.createDiv({ cls: 'planner-stat-value', text: String(val) });
      card.createDiv({ cls: 'planner-stat-label', text: String(lbl) });
    }

    // Currently reading
    const currentlyReading = allBooks.filter(b => b.status.includes('📖'));
    if (currentlyReading.length > 0) {
      const crBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const hdr = crBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📖 ${isRu ? 'Сейчас читаю' : 'Currently Reading'}` });
      for (const book of currentlyReading) {
        const bookEl = crBlock.createDiv({ cls: 'planner-reading-book-card' });
        bookEl.createEl('strong', { text: book.title });
        bookEl.createSpan({ text: ` — ${book.author}` });
        const progWrap = bookEl.createDiv({ cls: 'planner-reading-progress-wrap' });
        progWrap.createSpan({ text: `${book.read}/${book.pages} ${isRu ? 'стр.' : 'p.'} (${book.progress}%)` });
        const bar = progWrap.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.addClass('planner-progress-bar-flex');
        const fill = bar.createDiv({ cls: 'planner-summary-progress-fill' });
        fill.style.setProperty('--bar-width', `${book.progress}%`);
      }
    }

    // All books table
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-block' });
    {
      const hdr = row1.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📚 ${isRu ? 'Все книги' : 'All Books'}` });
      const tbl = row1.createEl('table', { cls: 'planner-summary-table' });
      const th = tbl.createEl('thead').createEl('tr');
      th.createEl('th', { text: isRu ? 'Название' : 'Title' });
      th.createEl('th', { text: isRu ? 'Автор' : 'Author' });
      th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
      th.createEl('th', { text: isRu ? 'Прогресс' : 'Progress' });
      th.createEl('th', { text: isRu ? 'Оценка' : 'Rating' });
      th.createEl('th', { text: isRu ? 'Заметки' : 'Notes' });
      const tb = tbl.createEl('tbody');

      // Sort: reading first, then finished, then queued
      const sortOrder = (s: string) => s.includes('📖') ? 0 : s.includes('✅') ? 1 : s.includes('⏸') ? 2 : 3;
      const sorted = [...allBooks].sort((a, b) => sortOrder(a.status) - sortOrder(b.status));

      for (const book of sorted) {
        const tr = tb.createEl('tr');
        tr.createEl('td', { text: book.title });
        tr.createEl('td', { text: book.author });
        tr.createEl('td', { text: book.status });
        const progCell = tr.createEl('td');
        const progBar = progCell.createDiv({ cls: 'planner-summary-progress-bar' });
        progBar.addClass('planner-progress-bar-inline-sm');
        const progFill = progBar.createDiv({ cls: 'planner-summary-progress-fill' });
        progFill.style.setProperty('--bar-width', `${book.progress}%`);
        progCell.createSpan({ text: ` ${book.progress}%`, cls: 'planner-summary-number' });
        const ratingCell = tr.createEl('td', { text: book.rating > 0 ? `${book.rating}/10` : '—', cls: 'planner-summary-number' });
        if (book.rating >= 8) ratingCell.classList.add('planner-summary-good');
        else if (book.rating > 0 && book.rating <= 3) ratingCell.classList.add('planner-summary-bad');
        tr.createEl('td', { text: book.notes });
      }
    }
  }

  /** Render dynamic weekly dashboard from daily planners */
  private renderWeeklySummary() {
    const year = this.nav.year!;
    const week = this.nav.week!;
    const days = getDaysInWeek(year, week);
    const startDate = days[0].date;
    const endDate = days[6].date;
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const dayLabelsShort = isRu ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const wLabel = `${days[0].dayNum} ${getMonthShort()[new Date(startDate).getMonth()]} — ${days[6].dayNum} ${getMonthShort()[new Date(endDate).getMonth()]}`;
    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `📋 ${isRu ? 'Еженедельный планер' : 'Weekly Planner'}: ${wLabel}` });

    // Parse all daily data
    const allDays = days.map((d, i) => {
      const block = dailyBlocks.find(b => b.day === d.date);
      return {
        date: d.date, dayName: d.dayName, dayNum: d.dayNum,
        label: dayLabelsShort[i],
        data: block ? this.parseDailyData(block) : null,
        block,
      };
    });

    // ═══════ ROW 1: Daily Tasks (left) + Habits (right) ═══════
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Daily Tasks ──
    const dtSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      let totalTasks = 0, doneTasks = 0;
      for (const day of allDays) {
        if (day.data) {
          totalTasks += day.data.tasks.length;
          doneTasks += day.data.tasks.filter(t => t.done).length;
        }
      }
      const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
      const hdr = dtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `✅ ${isRu ? 'Ежедневные задачи' : 'Daily Tasks'}` });
      if (totalTasks > 0) {
        const pRow = hdr.createDiv({ cls: 'planner-weekly-progress-row' });
        pRow.createSpan({ text: `${doneTasks}/${totalTasks} (${pct}%)`, cls: 'planner-weekly-progress-label' });
        const bar = pRow.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.createDiv({ cls: 'planner-summary-progress-fill' }).style.setProperty('--bar-width', `${pct}%`);
      }

      const tasksByName = new Map<string, Map<string, { done: boolean; priority: string; category: string }>>();
      for (const day of allDays) {
        if (day.data) {
          for (const t of day.data.tasks) {
            if (!t.task) continue;
            if (!tasksByName.has(t.task)) tasksByName.set(t.task, new Map());
            tasksByName.get(t.task)!.set(day.date, { done: t.done, priority: t.priority, category: t.category });
          }
        }
      }
      // Collect first known priority/category per task
      const taskMeta = new Map<string, { priority: string; category: string }>();
      for (const [name, dayMap] of tasksByName) {
        for (const [, entry] of dayMap) {
          if (!taskMeta.has(name)) taskMeta.set(name, { priority: entry.priority || '', category: entry.category || '' });
          break;
        }
      }
      if (tasksByName.size > 0) {
        const tbl = dtSection.createEl('table', { cls: 'planner-summary-table planner-weekly-habit-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        for (const day of allDays) th.createEl('th', { text: day.label });
        const tb = tbl.createEl('tbody');
        for (const [name, dayMap] of tasksByName) {
          const tr = tb.createEl('tr');
          const meta = taskMeta.get(name);
          const nameTd = tr.createEl('td', { text: name, cls: 'planner-clickable' });
          nameTd.addEventListener('click', () => {
            this.editWeeklyItem('dailyTasks', { task: name, priority: meta?.priority || '', category: meta?.category || '' }, startDate, endDate);
          });
          tr.createEl('td', { text: meta?.priority || '' });
          tr.createEl('td', { text: meta?.category || '' });
          for (const day of allDays) {
            const entry = dayMap.get(day.date);
            if (!entry) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              tr.createEl('td', { text: entry.done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
            }
          }
        }
      }
      const addBtn = dtSection.createEl('button', {
        text: `+ ${isRu ? 'Добавить задачу' : 'Add task'}`,
        cls: 'planner-weekly-add-btn',
      });
      addBtn.addEventListener('click', () => this.addWeeklyItem('dailyTasks', week, year, days));
    }

    // ── Habits ──
    const hbSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const allHabits = new Map<string, Record<string, boolean>>();
      for (const day of allDays) {
        if (day.data) {
          for (const h of day.data.habits) {
            if (!allHabits.has(h.habit)) allHabits.set(h.habit, {});
            allHabits.get(h.habit)![day.date] = h.done;
          }
        }
      }
      let totalH = 0, doneH = 0;
      for (const [, dayMap] of allHabits) {
        for (const day of allDays) {
          if (day.data) { totalH++; if (dayMap[day.date]) doneH++; }
        }
      }
      const hPct = totalH > 0 ? Math.round((doneH / totalH) * 100) : 0;
      const hdr = hbSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🔄 ${isRu ? 'Ежедневные привычки' : 'Daily Habits'}` });
      if (totalH > 0) {
        const pRow = hdr.createDiv({ cls: 'planner-weekly-progress-row' });
        pRow.createSpan({ text: `${hPct}%`, cls: 'planner-weekly-progress-label' });
        const bar = pRow.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.createDiv({ cls: 'planner-summary-progress-fill' }).style.setProperty('--bar-width', `${hPct}%`);
      }

      if (allHabits.size > 0) {
        const tbl = hbSection.createEl('table', { cls: 'planner-summary-table planner-weekly-habit-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Привычка' : 'Habit' });
        for (const day of allDays) th.createEl('th', { text: day.label });
        th.createEl('th', { text: '%' });
        const tb = tbl.createEl('tbody');
        for (const [name, dayMap] of allHabits) {
          const tr = tb.createEl('tr');
          const nameTd = tr.createEl('td', { text: name, cls: 'planner-clickable' });
          nameTd.addEventListener('click', () => {
            this.editWeeklyItem('habits', { habit: name }, startDate, endDate);
          });
          let count = 0;
          for (const day of allDays) {
            const done = dayMap[day.date] || false;
            tr.createEl('td', { text: done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
            if (done) count++;
          }
          const p = Math.round((count / 7) * 100);
          tr.createEl('td', { text: `${p}%`, cls: p >= 70 ? 'planner-summary-good' : '' });
        }
      }

      const addBtn = hbSection.createEl('button', {
        text: `+ ${isRu ? 'Добавить привычку' : 'Add habit'}`,
        cls: 'planner-weekly-add-btn',
      });
      addBtn.addEventListener('click', () => this.addWeeklyItem('habits', week, year, days));
    }

    // ═══════ ROW 2: Weekly Tasks (left) + Schedule (right) ═══════
    const row2 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Weekly Tasks ──
    const wtSection = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    const allWeeklyTasks = new Map<string, { done: boolean; task: string; priority: string; category: string; completedDate: string }>();
    for (const day of allDays) {
      if (day.data) {
        for (const t of day.data.weeklyTasks) {
          const existing = allWeeklyTasks.get(t.task);
          if (!existing || (t.done && !existing.done)) allWeeklyTasks.set(t.task, t);
        }
      }
    }
    {
      const wDone = [...allWeeklyTasks.values()].filter(t => t.done).length;
      const wTotal = allWeeklyTasks.size;
      const wPct = wTotal > 0 ? Math.round((wDone / wTotal) * 100) : 0;
      const hdr = wtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🎯 ${isRu ? 'Задачи на неделю' : 'Weekly Tasks'}` });
      if (wTotal > 0) {
        const pRow = hdr.createDiv({ cls: 'planner-weekly-progress-row' });
        pRow.createSpan({ text: `${wDone}/${wTotal} (${wPct}%)`, cls: 'planner-weekly-progress-label' });
        const bar = pRow.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.createDiv({ cls: 'planner-summary-progress-fill' }).style.setProperty('--bar-width', `${wPct}%`);
      }

      if (allWeeklyTasks.size > 0) {
        const tbl = wtSection.createEl('table', { cls: 'planner-summary-table planner-weekly-task-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: '✓' });
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Завершено' : 'Completed' });
        const tb = tbl.createEl('tbody');
        for (const [, t] of allWeeklyTasks) {
          const tr = tb.createEl('tr');
          if (t.done) tr.addClass('planner-weekly-done-row');
          tr.createEl('td', { text: t.done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
          const taskTd = tr.createEl('td', { text: t.task, cls: 'planner-clickable' });
          taskTd.addEventListener('click', () => {
            this.editWeeklyItem('weeklyTasks', t, startDate, endDate);
          });
          tr.createEl('td', { text: t.priority });
          tr.createEl('td', { text: t.category || '' });
          const dateCell = tr.createEl('td', { text: t.completedDate, cls: 'planner-weekly-day-label' });
          if (t.completedDate) {
            dateCell.addClass('planner-clickable');
            dateCell.addEventListener('click', () => this.navigateToDay(t.completedDate));
          }
        }
      }

      const addBtn = wtSection.createEl('button', {
        text: `+ ${isRu ? 'Добавить задачу' : 'Add task'}`,
        cls: 'planner-weekly-add-btn',
      });
      addBtn.addEventListener('click', () => this.addWeeklyItem('weeklyTasks', week, year, days));
    }

    // ── Schedule ──
    const schSection = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    const schHeader = schSection.createDiv({ cls: 'planner-weekly-block-header' });
    schHeader.createEl('h4', { text: `📅 ${isRu ? 'Расписание' : 'Schedule'}` });

    let viewInterval = 60;
    const intervalSel = document.createElement('select');
    intervalSel.className = 'planner-section-control';
    for (const opt of [
      { label: '15 ' + (isRu ? 'мин' : 'min'), value: 15 },
      { label: '30 ' + (isRu ? 'мин' : 'min'), value: 30 },
      { label: '60 ' + (isRu ? 'мин' : 'min'), value: 60 },
    ]) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      if (opt.value === viewInterval) o.selected = true;
      intervalSel.appendChild(o);
    }
    schHeader.appendChild(intervalSel);

    const daysContainer = schSection.createDiv({ cls: 'planner-weekly-days-grid' });

    const timeToMinutes = (t: string) => {
      const [hh, mm] = t.split(':').map(Number);
      return hh * 60 + (mm || 0);
    };
    const minutesToTime = (m: number) => {
      const h = Math.floor(m / 60);
      const min = m % 60;
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    };

    const renderScheduleGrid = () => {
      while (daysContainer.firstChild) daysContainer.removeChild(daysContainer.firstChild);
      const slots: string[] = [];
      for (let m = 360; m <= 1320; m += viewInterval) {
        slots.push(minutesToTime(m));
      }

      for (const day of allDays) {
        const dayCol = daysContainer.createDiv({ cls: 'planner-weekly-day-col' });
        const hasPlanner = !!day.data;

        const dayHeader = dayCol.createDiv({ cls: `planner-weekly-day-header ${hasPlanner ? 'has-planner' : 'no-planner'}` });
        dayHeader.createEl('span', { text: day.label, cls: 'planner-weekly-day-title' });
        dayHeader.createEl('span', { text: `${day.dayNum}`, cls: 'planner-weekly-day-date' });
        dayHeader.addEventListener('click', () => {
          this.navigate({ level: 'day', year, month: this.nav.month, week, day: day.date });
        });

        if (!hasPlanner) {
          dayCol.createDiv({ cls: 'planner-weekly-day-empty', text: isRu ? 'Нет планера' : 'No planner' });
          continue;
        }

        const slotTasks = new Map<string, string[]>();
        for (const s of slots) slotTasks.set(s, []);

        for (const entry of day.data!.fullSchedule) {
          if (!entry.task) continue;
          const entryMins = timeToMinutes(entry.time);
          let bestSlot = slots[0];
          let bestDiff = Infinity;
          for (const slot of slots) {
            const diff = Math.abs(timeToMinutes(slot) - entryMins);
            if (diff < bestDiff) { bestDiff = diff; bestSlot = slot; }
          }
          const tasks = entry.task.split(',').map((s: string) => s.trim()).filter(Boolean);
          slotTasks.get(bestSlot)!.push(...tasks);
        }

        const schedTable = dayCol.createEl('table', { cls: 'planner-weekly-day-table planner-weekly-schedule-table' });
        const stbody = schedTable.createEl('tbody');
        for (const slot of slots) {
          const tasks = slotTasks.get(slot)!;
          const tr = stbody.createEl('tr');
          if (tasks.length > 0) tr.addClass('has-task');
          tr.createEl('td', { text: slot, cls: 'planner-weekly-day-time' });
          tr.createEl('td', { text: tasks.join(', '), cls: tasks.length > 0 ? '' : 'planner-weekly-empty-slot' });
        }
      }
    };

    renderScheduleGrid();
    intervalSel.addEventListener('change', () => {
      viewInterval = Number(intervalSel.value);
      renderScheduleGrid();
    });

    // ═══════ ROW 3: Mood + Exercise ═══════
    const row3 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Mood by day ──
    {
      const moodSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = moodSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🌟 ${isRu ? 'Самочувствие' : 'Mood'}` });

      const moodByDay = new Map<string, { label: string; metrics: Map<string, number> }>();
      for (const day of allDays) {
        if (!day.data) continue;
        if (day.data.mood.length > 0) {
          const mMap = new Map<string, number>();
          for (const m of day.data.mood) mMap.set(m.metric, m.value);
          moodByDay.set(day.date, { label: day.label, metrics: mMap });
        }
      }

      if (moodByDay.size > 0) {
        const allMetrics = new Set<string>();
        for (const { metrics } of moodByDay.values()) for (const k of metrics.keys()) allMetrics.add(k);
        const tbl = moodSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Показатель' : 'Metric' });
        const dayKeys = [...moodByDay.keys()];
        for (const dk of dayKeys) th.createEl('th', { text: moodByDay.get(dk)!.label });
        th.createEl('th', { text: isRu ? 'Средн.' : 'Avg' });
        const tb = tbl.createEl('tbody');
        for (const metric of allMetrics) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: metric });
          let sum = 0, cnt = 0;
          for (const dk of dayKeys) {
            const v = moodByDay.get(dk)!.metrics.get(metric);
            if (v !== undefined) {
              const cls = v >= 7 ? 'planner-summary-good' : v <= 3 ? 'planner-summary-bad' : '';
              tr.createEl('td', { text: String(v), cls: `planner-summary-habit-cell ${cls}` });
              sum += v; cnt++;
            } else {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            }
          }
          const avg = cnt > 0 ? Math.round((sum / cnt) * 10) / 10 : 0;
          tr.createEl('td', { text: cnt > 0 ? String(avg) : '—', cls: avg >= 7 ? 'planner-summary-good' : '' });
        }
      } else {
        moodSection.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }

    // ── Exercise by day ──
    {
      const exSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = exSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🏋️ ${isRu ? 'Тренировки' : 'Exercise'}` });

      const exByDay = new Map<string, { label: string; exercises: { exercise: string; value: number; unit: string }[] }>();
      for (const day of allDays) {
        if (!day.data) continue;
        if (day.data.exercise.length > 0) {
          exByDay.set(day.date, { label: day.label, exercises: day.data.exercise });
        }
      }

      if (exByDay.size > 0) {
        const allExNames = new Set<string>();
        for (const { exercises } of exByDay.values()) for (const e of exercises) allExNames.add(e.exercise);
        const tbl = exSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Упражнение' : 'Exercise' });
        const dayKeys = [...exByDay.keys()];
        for (const dk of dayKeys) th.createEl('th', { text: exByDay.get(dk)!.label });
        th.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const tb = tbl.createEl('tbody');
        for (const exName of allExNames) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: exName });
          let total = 0;
          let unit = '';
          for (const dk of dayKeys) {
            const ex = exByDay.get(dk)!.exercises.find(e => e.exercise === exName);
            if (ex) {
              tr.createEl('td', { text: `${ex.value}`, cls: 'planner-summary-habit-cell' });
              total += ex.value;
              if (!unit) unit = ex.unit;
            } else {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            }
          }
          tr.createEl('td', { text: `${total}${unit ? ' ' + unit : ''}` });
        }
      } else {
        exSection.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }

    // ═══════ ROW 4: Notes (full width) ═══════
    {
      const weekNotes: { day: string; label: string; task: string; note: string }[] = [];
      for (const day of allDays) {
        if (!day.block) continue;
        try {
          const rawSchema = parseSchema(day.block.yaml);
          const expanded = rawSchema.template ? expandTemplate(rawSchema) : rawSchema;
          const sections = (expanded as PlannerSchema).sections;
          if (sections?.notes) {
            for (const n of sections.notes as Record<string, string | number | boolean>[]) {
              if (n.note) weekNotes.push({ day: day.date, label: day.label, task: n.task || '', note: n.note });
            }
          }
        } catch { /* skip */ }
      }

      const notesBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const hdr = notesBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📝 ${isRu ? 'Заметки' : 'Notes'}` });

      if (weekNotes.length > 0) {
        const tbl = notesBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'День' : 'Day' });
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Заметка' : 'Note' });
        const tb = tbl.createEl('tbody');
        for (const n of weekNotes) {
          const tr = tb.createEl('tr');
          const dateCell = tr.createEl('td', { text: `${n.label} ${n.day.substring(8)}`, cls: 'planner-weekly-day-label planner-clickable' });
          dateCell.addEventListener('click', () => this.navigateToDay(n.day));
          tr.createEl('td', { text: n.task });
          tr.createEl('td', { text: n.note });
        }
      } else {
        notesBlock.createEl('p', { text: isRu ? 'Нет заметок за эту неделю' : 'No notes for this week', cls: 'planner-weekly-no-data' });
      }
    }
  }

  /** Resolve subtable title to item type for addWeeklyItem */
  private resolveSubtableType(title: string): 'weeklyTasks' | 'monthlyTasks' | 'habits' | 'dailyTasks' | 'notes' | 'mood' | 'exercise' | null {
    if (title.includes('Привычки') || title.includes('Habits')) return 'habits';
    if (title.includes('Задачи на месяц') || title.includes('Monthly Tasks')) return 'monthlyTasks';
    if (title.includes('Задачи на неделю') || title.includes('Weekly Tasks')) return 'weeklyTasks';
    if (title.includes('Ежедневные') || title.includes('Daily')) return 'dailyTasks';
    if (title.includes('Заметки') || title.includes('Notes')) return 'notes';
    if (title.includes('Самочувствие') || title.includes('Mood')) return 'mood';
    if (title.includes('Тренировки') || title.includes('Exercise')) return 'exercise';
    return null;
  }

  /** Edit a task/habit from the weekly dashboard */
  private editWeeklyItem(
    type: 'weeklyTasks' | 'monthlyTasks' | 'dailyTasks' | 'habits',
    item: { task?: string; habit?: string; priority?: string; category?: string; description?: string },
    startDate: string, endDate: string,
  ) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Редактировать' : 'Edit');
    const contentEl = modal.contentEl;
    const oldName = item.task || item.habit || '';
    let nameVal = oldName;
    let priorityVal = item.priority || '';
    let categoryVal = item.category || '';
    let descVal = item.description || '';

    new Setting(contentEl)
      .setName(type === 'habits' ? (isRu ? 'Привычка' : 'Habit') : (isRu ? 'Задача' : 'Task'))
      .addText(txt => { txt.setValue(nameVal); txt.onChange(v => nameVal = v); });

    if (type === 'habits') {
      new Setting(contentEl)
        .setName(isRu ? 'Описание' : 'Description')
        .addText(txt => { txt.setValue(descVal); txt.onChange(v => descVal = v); });
    } else {
      const priorities = (type === 'weeklyTasks' || type === 'monthlyTasks')
        ? (isRu
          ? ['🔴 Срочно / Важно', '🟡 Не срочно / Важно', '🟠 Срочно / Не важно', '🟢 Не срочно / Не важно']
          : ['🔴 Urgent / Important', '🟡 Not Urgent / Important', '🟠 Urgent / Not Important', '🟢 Not Urgent / Not Important'])
        : (isRu
          ? ['🔴 Важно', '🟡 Средне', '🟢 Не важно']
          : ['🔴 Important', '🟡 Medium', '🟢 Not Important']);
      new Setting(contentEl)
        .setName(isRu ? 'Приоритет' : 'Priority')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const p of priorities) dd.addOption(p, p);
          dd.setValue(priorityVal);
          dd.onChange(v => priorityVal = v);
        });
      const categories = isRu
        ? ['Работа', 'Личное', 'Здоровье', 'Учёба', 'Другое']
        : ['Work', 'Personal', 'Health', 'Study', 'Other'];
      new Setting(contentEl)
        .setName(isRu ? 'Категория' : 'Category')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const c of categories) dd.addOption(c, c);
          dd.setValue(categoryVal);
          dd.onChange(v => categoryVal = v);
        });
    }

    const btnRow = new Setting(contentEl);
    btnRow.addButton(btn => btn.setButtonText(isRu ? 'Сохранить' : 'Save').setCta().onClick(async () => {
      modal.close();
      const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
      for (const block of dailyBlocks) {
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) continue;
          const sections = (schema as PlannerSchema).sections;
          const sectionKey = type === 'weeklyTasks' ? 'weeklyTasks' : type === 'monthlyTasks' ? 'monthlyTasks' : type === 'dailyTasks' ? 'tasks' : 'habits';
          const nameField = type === 'habits' ? 'habit' : 'task';
          const items = sections[sectionKey] as Record<string, string | number | boolean>[];
          if (!items) continue;
          let changed = false;
          for (const row of items) {
            if (row[nameField] === oldName) {
              row[nameField] = nameVal;
              if (type !== 'habits') {
                row.priority = priorityVal;
                row.category = categoryVal;
              } else {
                row.description = descVal;
              }
              changed = true;
            }
          }
          if (!changed) continue;
          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) continue;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
      }
      void this.refresh();
    }));
    btnRow.addButton(btn => btn.setButtonText(isRu ? 'Удалить' : 'Delete').setWarning().onClick(async () => {
      modal.close();
      const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
      for (const block of dailyBlocks) {
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) continue;
          const sections = (schema as PlannerSchema).sections;
          const sectionKey = type === 'weeklyTasks' ? 'weeklyTasks' : type === 'monthlyTasks' ? 'monthlyTasks' : type === 'dailyTasks' ? 'tasks' : 'habits';
          const nameField = type === 'habits' ? 'habit' : 'task';
          const items = sections[sectionKey] as Record<string, string | number | boolean>[];
          if (!items) continue;
          const filtered = items.filter((row: Record<string, string | number | boolean>) => row[nameField] !== oldName);
          if (filtered.length === items.length) continue;
          if (filtered.length === 0 || !filtered.some((r: Record<string, string | number | boolean>) => !r[nameField])) {
            const empty: Record<string, string | number | boolean> = {};
            for (const key of Object.keys(items[0] || {})) empty[key] = key === 'done' ? false : '';
            filtered.push(empty);
          }
          sections[sectionKey] = filtered;
          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) continue;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
      }
      void this.refresh();
    }));
    modal.open();
  }

  /** Add a weekly task or habit from the weekly dashboard, syncing to all dailies */
  private addWeeklyItem(
    type: 'weeklyTasks' | 'monthlyTasks' | 'habits' | 'dailyTasks',
    week: number, year: number,
    days: { date: string; dayName: string; dayNum: number }[],
  ) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    const titles: Record<string, string> = {
      weeklyTasks: isRu ? 'Добавить задачу на неделю' : 'Add weekly task',
      monthlyTasks: isRu ? 'Добавить задачу на месяц' : 'Add monthly task',
      dailyTasks: isRu ? 'Добавить ежедневную задачу' : 'Add daily task',
      habits: isRu ? 'Добавить привычку' : 'Add habit',
    };
    modal.titleEl.setText(titles[type]);

    const contentEl = modal.contentEl;
    let nameVal = '';
    let descVal = '';
    let priorityVal = '';
    let categoryVal = '';

    new Setting(contentEl)
      .setName(type === 'habits' ? (isRu ? 'Привычка' : 'Habit') : (isRu ? 'Задача' : 'Task'))
      .addText(txt => txt.onChange(v => nameVal = v));

    if (type === 'habits') {
      new Setting(contentEl)
        .setName(isRu ? 'Описание' : 'Description')
        .addText(txt => txt.onChange(v => descVal = v));
    } else {
      const priorities = (type === 'weeklyTasks' || type === 'monthlyTasks')
        ? (isRu
          ? ['🔴 Срочно / Важно', '🟡 Не срочно / Важно', '🟠 Срочно / Не важно', '🟢 Не срочно / Не важно']
          : ['🔴 Urgent / Important', '🟡 Not Urgent / Important', '🟠 Urgent / Not Important', '🟢 Not Urgent / Not Important'])
        : (isRu
          ? ['🔴 Важно', '🟡 Средне', '🟢 Не важно']
          : ['🔴 Important', '🟡 Medium', '🟢 Not Important']);
      new Setting(contentEl)
        .setName(isRu ? 'Приоритет' : 'Priority')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const p of priorities) dd.addOption(p, p);
          dd.onChange(v => priorityVal = v);
        });
      const categories = isRu
        ? ['Работа', 'Личное', 'Здоровье', 'Учёба', 'Другое']
        : ['Work', 'Personal', 'Health', 'Study', 'Other'];
      new Setting(contentEl)
        .setName(isRu ? 'Категория' : 'Category')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const c of categories) dd.addOption(c, c);
          dd.onChange(v => categoryVal = v);
        });
    }

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!nameVal.trim()) return;
        modal.close();
        // Determine range: month-wide for monthlyTasks, week-wide for others
        let startDate: string, endDate: string;
        if (type === 'monthlyTasks') {
          const monthStr = days[0].date.substring(0, 7);
          const [y, m] = monthStr.split('-').map(Number);
          const dim = new Date(y, m, 0).getDate();
          startDate = `${monthStr}-01`;
          endDate = `${monthStr}-${String(dim).padStart(2, '0')}`;
        } else {
          startDate = days[0].date;
          endDate = days[6].date;
        }
        const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);

        for (const block of dailyBlocks) {
          try {
            const schema = parseSchema(block.yaml);
            if (!schema.sections) (schema as PlannerSchema).sections = {};
            const sections = (schema as PlannerSchema).sections;

            if (type === 'weeklyTasks' || type === 'monthlyTasks') {
              const key = type === 'monthlyTasks' ? 'monthlyTasks' : 'weeklyTasks';
              if (!sections[key]) sections[key] = [];
              const existing = (sections[key] as Record<string, string | number | boolean>[]).some((t: Record<string, string | number | boolean>) => t.task === nameVal);
              if (existing) continue;
              sections[key] = sections[key].filter((t: Record<string, string | number | boolean>) => t.task);
              sections[key].push({ done: false, task: nameVal, priority: priorityVal, category: categoryVal, completedDate: '' });
              sections[key].push({ done: false, task: '', priority: '', category: '', completedDate: '' });
            } else if (type === 'dailyTasks') {
              if (!sections.tasks) sections.tasks = [];
              const existing = (sections.tasks as Record<string, string | number | boolean>[]).some((t: Record<string, string | number | boolean>) => t.task === nameVal);
              if (existing) continue;
              sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
              sections.tasks.push({ done: false, task: nameVal, priority: priorityVal, category: categoryVal });
              sections.tasks.push({ done: false, task: '', priority: '', category: '' });
            } else {
              if (!sections.habits) sections.habits = [];
              const existing = (sections.habits as Record<string, string | number | boolean>[]).some((h: Record<string, string | number | boolean>) => h.habit === nameVal);
              if (existing) continue;
              sections.habits = sections.habits.filter((h: Record<string, string | number | boolean>) => h.habit);
              sections.habits.push({ habit: nameVal, description: descVal, done: false });
              sections.habits.push({ habit: '', description: '', done: false });
            }

            const newYaml = serializeSchema(schema);
            const file = this.app.vault.getAbstractFileByPath(block.file);
            if (!file) continue;
            const content = await this.app.vault.read(file as TFile);
            const searchStr = '```planner\n' + block.originalYaml + '```';
            const replaceStr = '```planner\n' + newYaml + '\n```';
            const newContent = content.replace(searchStr, replaceStr);
            if (newContent !== content) {
              await this.app.vault.modify(file as TFile, newContent);
              block.originalYaml = newYaml + '\n';
              block.yaml = newYaml;
            }
          } catch { /* skip */ }
        }
        await this.refresh();
      }));

    modal.open();
  }

  /** Add a note to a specific daily planner block */
  private addNoteModal(block: PlannerBlock) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить заметку' : 'Add note');
    const contentEl = modal.contentEl;
    let taskVal = '';
    let noteVal = '';

    // Collect all task names from the planner
    const taskNames: string[] = [];
    try {
      const schema = parseSchema(block.yaml);
      const sections = (schema as PlannerSchema).sections || {};
      for (const key of ['tasks', 'weeklyTasks', 'monthlyTasks']) {
        const arr = sections[key] as Record<string, string | number | boolean>[] | undefined;
        if (arr) arr.forEach((t: Record<string, string | number | boolean>) => { if ((t.task as string)?.trim()) taskNames.push((t.task as string).trim()); });
      }
    } catch { /* skip */ }

    new Setting(contentEl)
      .setName(isRu ? 'Задача' : 'Task')
      .addDropdown(dd => {
        dd.addOption('', isRu ? '— выбрать —' : '— select —');
        taskNames.forEach(name => dd.addOption(name, name));
        dd.onChange(v => taskVal = v);
      });
    new Setting(contentEl)
      .setName(isRu ? 'Заметка' : 'Note')
      .addText(txt => txt.onChange(v => noteVal = v));

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!noteVal.trim()) return;
        modal.close();
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.notes) sections.notes = [];
          sections.notes = sections.notes.filter((n: Record<string, string | number | boolean>) => n.note || n.task);
          sections.notes.push({ task: taskVal, note: noteVal });
          sections.notes.push({ task: '', note: '' });
          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
        await this.refresh();
      }));
    modal.open();
  }

  /** Add a mood entry to a daily planner block */
  private addMoodModal(block: PlannerBlock) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить самочувствие' : 'Add mood');
    const contentEl = modal.contentEl;
    let metricVal = '';
    let valueVal = '';

    new Setting(contentEl)
      .setName(isRu ? 'Показатель' : 'Metric')
      .addText(txt => { txt.setPlaceholder(isRu ? '😊 Настроение' : '😊 Mood'); txt.onChange(v => metricVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Оценка (1–10)' : 'Rating (1–10)')
      .addText(txt => { txt.setPlaceholder('1–10'); txt.onChange(v => valueVal = v); });

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!metricVal.trim() || !valueVal.trim()) return;
        modal.close();
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.mood) sections.mood = [];
          sections.mood = sections.mood.filter((m: Record<string, string | number | boolean>) => m.metric || m.value);
          sections.mood.push({ metric: metricVal, value: Number(valueVal) || 0 });
          sections.mood.push({ metric: '', value: '' });
          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
        await this.refresh();
      }));
    modal.open();
  }

  /** Add an exercise entry to a daily planner block */
  private addExerciseModal(block: PlannerBlock) {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить тренировку' : 'Add exercise');
    const contentEl = modal.contentEl;
    let exerciseVal = '';
    let valueVal = '';
    let unitVal = '';

    new Setting(contentEl)
      .setName(isRu ? 'Упражнение' : 'Exercise')
      .addText(txt => { txt.setPlaceholder(isRu ? 'Отжимания' : 'Push-ups'); txt.onChange(v => exerciseVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Значение' : 'Value')
      .addText(txt => { txt.setPlaceholder('30'); txt.onChange(v => valueVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Единица' : 'Unit')
      .addText(txt => { txt.setPlaceholder(isRu ? 'раз' : 'reps'); txt.onChange(v => unitVal = v); });

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!exerciseVal.trim()) return;
        modal.close();
        try {
          const schema = parseSchema(block.yaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.exercise) sections.exercise = [];
          sections.exercise = sections.exercise.filter((e: Record<string, string | number | boolean>) => e.exercise || e.value);
          sections.exercise.push({ exercise: exerciseVal, value: Number(valueVal) || 0, unit: unitVal });
          sections.exercise.push({ exercise: '', value: '', unit: '' });
          const newYaml = serializeSchema(schema);
          const file = this.app.vault.getAbstractFileByPath(block.file);
          if (!file) return;
          const content = await this.app.vault.read(file as TFile);
          const searchStr = '```planner\n' + block.originalYaml + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(file as TFile, newContent);
            block.originalYaml = newYaml + '\n';
            block.yaml = newYaml;
          }
        } catch { /* skip */ }
        await this.refresh();
      }));
    modal.open();
  }

  /** Render dynamic monthly summary from daily planners */
  private renderMonthlySummary() {
    const year = this.nav.year!;
    const month = this.nav.month!;
    const monthPad = String(month).padStart(2, '0');
    const startDate = `${year}-${monthPad}-01`;
    const daysInMonth = new Date(year, month, 0).getDate();
    const endDate = `${year}-${monthPad}-${String(daysInMonth).padStart(2, '0')}`;
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';

    if (dailyBlocks.length === 0) return;

    const weeks = getWeeksInMonth(year, month);
    const weekLabels: string[] = [];
    const weekRanges: { start: string; end: string }[] = [];
    for (const w of weeks) {
      const wStart = `${w.start.getFullYear()}-${String(w.start.getMonth() + 1).padStart(2, '0')}-${String(w.start.getDate()).padStart(2, '0')}`;
      const wEnd = `${w.end.getFullYear()}-${String(w.end.getMonth() + 1).padStart(2, '0')}-${String(w.end.getDate()).padStart(2, '0')}`;
      weekRanges.push({ start: wStart, end: wEnd });
      weekLabels.push(`${w.start.getDate()}–${w.end.getDate()}`);
    }

    // Parse all daily data
    const allDailyData: { day: string; data: ReturnType<typeof this.parseDailyData> }[] = [];
    for (const block of dailyBlocks) {
      allDailyData.push({ day: block.day!, data: this.parseDailyData(block) });
    }

    // Aggregate totals
    let totalTasks = 0, doneTasks = 0, totalHabitChecks = 0, doneHabitChecks = 0;
    let totalWeeklyTasks = 0, doneWeeklyTasks = 0;
    let totalMonthlyTasks = 0, doneMonthlyTasks = 0;
    const monthlyTasksMap = new Map<string, { priority: string; category: string; done: boolean; completedDate: string }>();

    for (const { data } of allDailyData) {
      totalTasks += data.tasks.length;
      doneTasks += data.tasks.filter(t => t.done).length;
      for (const h of data.habits) {
        totalHabitChecks++;
        if (h.done) doneHabitChecks++;
      }
      totalWeeklyTasks += data.weeklyTasks.length;
      doneWeeklyTasks += data.weeklyTasks.filter(t => t.done).length;
      for (const t of data.monthlyTasks) {
        if (!monthlyTasksMap.has(t.task)) {
          monthlyTasksMap.set(t.task, { priority: t.priority, category: t.category, done: t.done, completedDate: t.completedDate });
        } else if (t.done) {
          const entry = monthlyTasksMap.get(t.task)!;
          entry.done = true;
          if (t.completedDate) entry.completedDate = t.completedDate;
        }
      }
    }
    totalMonthlyTasks = monthlyTasksMap.size;
    doneMonthlyTasks = [...monthlyTasksMap.values()].filter(t => t.done).length;

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `📊 ${isRu ? 'Сводка за месяц' : 'Monthly Summary'}: ${getMonthNames()[month - 1]} ${year}` });

    // ═══════ STATS CARDS ═══════
    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    const taskPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
    const habitPct = totalHabitChecks > 0 ? Math.round((doneHabitChecks / totalHabitChecks) * 100) : 0;
    const weeklyPct = totalWeeklyTasks > 0 ? Math.round((doneWeeklyTasks / totalWeeklyTasks) * 100) : 0;
    const monthlyPct = totalMonthlyTasks > 0 ? Math.round((doneMonthlyTasks / totalMonthlyTasks) * 100) : 0;

    const makeCard = (icon: string, label: string, value: string, pct: number) => {
      const card = statsRow.createDiv({ cls: 'planner-monthly-stat-card' });
      card.createEl('div', { text: icon, cls: 'planner-monthly-stat-icon' });
      card.createEl('div', { text: label, cls: 'planner-monthly-stat-label' });
      card.createEl('div', { text: value, cls: 'planner-monthly-stat-value' });
      if (pct >= 0) {
        const bar = card.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.createDiv({ cls: 'planner-summary-progress-fill' }).style.setProperty('--bar-width', `${pct}%`);
      }
    };
    makeCard('📅', isRu ? 'Планеров' : 'Planners', `${dailyBlocks.length}/${daysInMonth}`, Math.round((dailyBlocks.length / daysInMonth) * 100));
    makeCard('✅', isRu ? 'Ежедневные' : 'Daily Tasks', `${doneTasks}/${totalTasks} (${taskPct}%)`, taskPct);
    makeCard('🔄', isRu ? 'Привычки' : 'Habits', `${doneHabitChecks}/${totalHabitChecks} (${habitPct}%)`, habitPct);
    makeCard('🎯', isRu ? 'На неделю' : 'Weekly', `${doneWeeklyTasks}/${totalWeeklyTasks} (${weeklyPct}%)`, weeklyPct);
    if (totalMonthlyTasks > 0) {
      makeCard('📆', isRu ? 'На месяц' : 'Monthly', `${doneMonthlyTasks}/${totalMonthlyTasks} (${monthlyPct}%)`, monthlyPct);
    }

    // ═══════ ROW 1: Habits by week + Daily tasks summary ═══════
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Habits by week ──
    const hbSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = hbSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🔄 ${isRu ? 'Привычки по неделям' : 'Habits by Week'}` });

      const habitWeekData = new Map<string, Map<number, { done: number; total: number }>>();
      for (let wi = 0; wi < weekRanges.length; wi++) {
        const wr = weekRanges[wi];
        for (const { data } of allDailyData.filter(d => d.day >= wr.start && d.day <= wr.end)) {
          for (const h of data.habits) {
            if (!h.habit) continue;
            if (!habitWeekData.has(h.habit)) habitWeekData.set(h.habit, new Map());
            const wMap = habitWeekData.get(h.habit)!;
            if (!wMap.has(wi)) wMap.set(wi, { done: 0, total: 0 });
            const entry = wMap.get(wi)!;
            entry.total++;
            if (h.done) entry.done++;
          }
        }
      }

      if (habitWeekData.size > 0) {
        const tbl = hbSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Привычка' : 'Habit' });
        for (const wl of weekLabels) th.createEl('th', { text: wl });
        th.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const tb = tbl.createEl('tbody');
        for (const [name, wMap] of habitWeekData) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: name });
          let totalD = 0, totalT = 0;
          for (let wi = 0; wi < weekLabels.length; wi++) {
            const entry = wMap.get(wi);
            if (!entry) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              const p = Math.round((entry.done / entry.total) * 100);
              const cls = p >= 70 ? 'planner-summary-good' : '';
              tr.createEl('td', { text: `${p}%`, cls: `planner-summary-habit-cell ${cls}` });
              totalD += entry.done;
              totalT += entry.total;
            }
          }
          const totalP = totalT > 0 ? Math.round((totalD / totalT) * 100) : 0;
          tr.createEl('td', { text: `${totalP}%`, cls: totalP >= 70 ? 'planner-summary-good' : '' });
        }
      }
    }

    // ── Daily tasks summary ──
    const dtSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = dtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `✅ ${isRu ? 'Ежедневные задачи' : 'Daily Tasks'}` });

      const taskStats = new Map<string, { appeared: number; done: number; priority: string; category: string }>();
      for (const { data } of allDailyData) {
        for (const t of data.tasks) {
          if (!t.task) continue;
          if (!taskStats.has(t.task)) taskStats.set(t.task, { appeared: 0, done: 0, priority: t.priority, category: t.category });
          const stat = taskStats.get(t.task)!;
          stat.appeared++;
          if (t.done) stat.done++;
        }
      }

      if (taskStats.size > 0) {
        const tbl = dtSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Выполнено' : 'Done' });
        th.createEl('th', { text: '%' });
        const tb = tbl.createEl('tbody');
        for (const [name, stat] of taskStats) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: name });
          tr.createEl('td', { text: stat.priority });
          tr.createEl('td', { text: stat.category });
          tr.createEl('td', { text: `${stat.done}/${stat.appeared}` });
          const p = Math.round((stat.done / stat.appeared) * 100);
          tr.createEl('td', { text: `${p}%`, cls: p >= 70 ? 'planner-summary-good' : '' });
        }
      }
    }

    // ═══════ ROW 2: Weekly tasks (left) + Monthly tasks (right) ═══════
    const row2 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Weekly tasks grouped by week ──
    const wtSection = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
    {
      const hdr = wtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🎯 ${isRu ? 'Задачи на неделю' : 'Weekly Tasks'}` });

      for (let wi = 0; wi < weekRanges.length; wi++) {
        const wr = weekRanges[wi];
        const weekDailies = allDailyData.filter(d => d.day >= wr.start && d.day <= wr.end);
        const weekTasks = new Map<string, { priority: string; category: string; done: boolean; completedDate: string }>();
        for (const { data } of weekDailies) {
          for (const t of data.weeklyTasks) {
            if (!t.task) continue;
            if (!weekTasks.has(t.task)) {
              weekTasks.set(t.task, { priority: t.priority, category: t.category, done: t.done, completedDate: t.completedDate });
            } else if (t.done) {
              const entry = weekTasks.get(t.task)!;
              entry.done = true;
              if (t.completedDate) entry.completedDate = t.completedDate;
            }
          }
        }
        if (weekTasks.size === 0) continue;

        wtSection.createEl('h5', { text: `${isRu ? 'Неделя' : 'Week'} ${weekLabels[wi]}`, cls: 'planner-monthly-week-label' });
        const tbl = wtSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
        th.createEl('th', { text: isRu ? 'Завершено' : 'Completed' });
        const tb = tbl.createEl('tbody');
        for (const [name, entry] of weekTasks) {
          const tr = tb.createEl('tr');
          if (entry.done) tr.addClass('planner-weekly-done-row');
          tr.createEl('td', { text: name });
          tr.createEl('td', { text: entry.priority });
          tr.createEl('td', { text: entry.category });
          tr.createEl('td', { text: entry.done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
          const dateCell1 = tr.createEl('td', { text: entry.completedDate, cls: 'planner-weekly-day-label' });
          if (entry.completedDate) {
            dateCell1.addClass('planner-clickable');
            dateCell1.addEventListener('click', () => this.navigateToDay(entry.completedDate));
          }
        }
      }
    }

    // ── Monthly tasks ──
    {
      const mtSection = row2.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = mtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📆 ${isRu ? 'Задачи на месяц' : 'Monthly Tasks'}` });

      const addBtn = hdr.createEl('button', { text: isRu ? 'Добавить задачу на месяц' : 'Add monthly task', cls: 'planner-weekly-add-btn' });
      addBtn.addEventListener('click', () => {
        const days = [{ date: startDate, dayName: '', dayNum: 1 }];
        this.addWeeklyItem('monthlyTasks', 0, year, days);
      });

      if (monthlyTasksMap.size > 0) {
        const tbl = mtSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
        th.createEl('th', { text: isRu ? 'Завершено' : 'Completed' });
        const tb = tbl.createEl('tbody');
        for (const [name, entry] of monthlyTasksMap) {
          const tr = tb.createEl('tr');
          if (entry.done) tr.addClass('planner-weekly-done-row');
          const nameCell = tr.createEl('td', { text: name, cls: 'planner-clickable' });
          nameCell.addEventListener('click', () => {
            this.editWeeklyItem('monthlyTasks', { task: name, priority: entry.priority, category: entry.category }, startDate, endDate);
          });
          tr.createEl('td', { text: entry.priority });
          tr.createEl('td', { text: entry.category });
          tr.createEl('td', { text: entry.done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
          const dateCell2 = tr.createEl('td', { text: entry.completedDate, cls: 'planner-weekly-day-label' });
          if (entry.completedDate) {
            dateCell2.addClass('planner-clickable');
            dateCell2.addEventListener('click', () => this.navigateToDay(entry.completedDate));
          }
        }
      } else {
        mtSection.createEl('p', { text: isRu ? 'Нет задач на месяц' : 'No monthly tasks', cls: 'planner-weekly-no-data' });
      }
    }

    // ═══════ ROW 3: Heatmap calendar + Completion chart ═══════
    const row3 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Heatmap calendar ──
    {
      const hmSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = hmSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📅 ${isRu ? 'Активность' : 'Activity'}` });

      const dayActivity = new Map<string, number>();
      for (const { day, data } of allDailyData) {
        let dayDone = data.tasks.filter(t => t.done).length;
        dayDone += data.habits.filter(h => h.done).length;
        dayDone += data.weeklyTasks.filter(t => t.done).length;
        dayDone += data.monthlyTasks.filter(t => t.done).length;
        dayActivity.set(day, dayDone);
      }
      const maxActivity = Math.max(1, ...dayActivity.values());
      const dayNames = isRu ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

      const cal = hmSection.createDiv({ cls: 'planner-monthly-heatmap' });
      const headerRow = cal.createDiv({ cls: 'planner-heatmap-row' });
      for (const dn of dayNames) {
        headerRow.createDiv({ text: dn, cls: 'planner-heatmap-cell planner-heatmap-header' });
      }

      const firstDay = new Date(year, month - 1, 1);
      const startDow = firstDay.getDay() || 7;
      let currentDay = 1;

      let weekRow = cal.createDiv({ cls: 'planner-heatmap-row' });
      for (let i = 1; i < startDow; i++) {
        weekRow.createDiv({ cls: 'planner-heatmap-cell planner-heatmap-empty' });
      }

      while (currentDay <= daysInMonth) {
        const dow = new Date(year, month - 1, currentDay).getDay() || 7;
        if (dow === 1 && currentDay > 1) {
          weekRow = cal.createDiv({ cls: 'planner-heatmap-row' });
        }
        const dateStr = `${year}-${monthPad}-${String(currentDay).padStart(2, '0')}`;
        const activity = dayActivity.get(dateStr) || 0;
        const hasPlanner = dayActivity.has(dateStr);
        const cell = weekRow.createDiv({ cls: 'planner-heatmap-cell' });
        cell.createEl('span', { text: String(currentDay), cls: 'planner-heatmap-day' });
        if (hasPlanner) {
          const intensity = Math.round((activity / maxActivity) * 4);
          cell.addClass(`planner-heatmap-level-${Math.min(intensity, 4)}`);
        } else {
          cell.addClass('planner-heatmap-no-data');
        }
        cell.setAttribute('title', hasPlanner ? `${dateStr}: ${activity} ${isRu ? 'выполнено' : 'done'}` : dateStr);
        cell.addEventListener('click', () => {
          const dt = new Date(year, month - 1, currentDay);
          const wk = getISOWeek(dt);
          this.navigate({ level: 'day', year, month, week: wk, day: dateStr });
        });
        currentDay++;
      }
      const lastDow = new Date(year, month - 1, daysInMonth).getDay() || 7;
      for (let i = lastDow + 1; i <= 7; i++) {
        weekRow.createDiv({ cls: 'planner-heatmap-cell planner-heatmap-empty' });
      }
    }

    // ── Completion chart (bar chart by week) ──
    {
      const chartSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = chartSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'Выполнение по неделям' : 'Completion by Week'}` });

      const chartArea = chartSection.createDiv({ cls: 'planner-monthly-chart' });
      for (let wi = 0; wi < weekRanges.length; wi++) {
        const wr = weekRanges[wi];
        const weekDailies = allDailyData.filter(d => d.day >= wr.start && d.day <= wr.end);
        let wTotal = 0, wDone = 0, wHTotal = 0, wHDone = 0;
        for (const { data } of weekDailies) {
          wTotal += data.tasks.length;
          wDone += data.tasks.filter(t => t.done).length;
          wHTotal += data.habits.length;
          wHDone += data.habits.filter(h => h.done).length;
        }
        const taskPctW = wTotal > 0 ? Math.round((wDone / wTotal) * 100) : 0;
        const habitPctW = wHTotal > 0 ? Math.round((wHDone / wHTotal) * 100) : 0;

        const barGroup = chartArea.createDiv({ cls: 'planner-chart-bar-group' });
        barGroup.createEl('div', { text: weekLabels[wi], cls: 'planner-chart-label' });
        const barsRow = barGroup.createDiv({ cls: 'planner-chart-bars' });
        // Tasks bar
        const taskBar = barsRow.createDiv({ cls: 'planner-chart-bar planner-chart-bar-tasks' });
        taskBar.createDiv({ cls: 'planner-chart-bar-fill' }).style.setProperty('--bar-width', `${taskPctW}%`);
        taskBar.setAttribute('title', `${isRu ? 'Задачи' : 'Tasks'}: ${taskPctW}%`);
        taskBar.createEl('span', { text: `${taskPctW}%`, cls: 'planner-chart-bar-text' });
        // Habits bar
        const habitBar = barsRow.createDiv({ cls: 'planner-chart-bar planner-chart-bar-habits' });
        habitBar.createDiv({ cls: 'planner-chart-bar-fill' }).style.setProperty('--bar-width', `${habitPctW}%`);
        habitBar.setAttribute('title', `${isRu ? 'Привычки' : 'Habits'}: ${habitPctW}%`);
        habitBar.createEl('span', { text: `${habitPctW}%`, cls: 'planner-chart-bar-text' });
      }
      // Legend
      const legend = chartArea.createDiv({ cls: 'planner-chart-legend' });
      const l1 = legend.createDiv({ cls: 'planner-chart-legend-item' });
      l1.createDiv({ cls: 'planner-chart-legend-color planner-chart-bar-tasks' });
      l1.createEl('span', { text: isRu ? 'Задачи' : 'Tasks' });
      const l2 = legend.createDiv({ cls: 'planner-chart-legend-item' });
      l2.createDiv({ cls: 'planner-chart-legend-color planner-chart-bar-habits' });
      l2.createEl('span', { text: isRu ? 'Привычки' : 'Habits' });
    }


    // ═══════ ROW 4: Mood + Exercise by week ═══════
    const row4moodMonthly = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Mood by week ──
    {
      const moodSec = row4moodMonthly.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const moodH = moodSec.createDiv({ cls: 'planner-weekly-block-header' });
      moodH.createEl('h4', { text: `🌟 ${isRu ? 'Самочувствие по неделям' : 'Mood by Week'}` });

      const moodWD = new Map<string, Map<number, { sum: number; count: number }>>();
      for (let wi = 0; wi < weekRanges.length; wi++) {
        const wr = weekRanges[wi];
        for (const { data } of allDailyData.filter(d => d.day >= wr.start && d.day <= wr.end)) {
          for (const m of data.mood) {
            if (!moodWD.has(m.metric)) moodWD.set(m.metric, new Map());
            const wMap = moodWD.get(m.metric)!;
            if (!wMap.has(wi)) wMap.set(wi, { sum: 0, count: 0 });
            const e2 = wMap.get(wi)!;
            e2.sum += m.value; e2.count++;
          }
        }
      }

      if (moodWD.size > 0) {
        const tbl = moodSec.createEl('table', { cls: 'planner-summary-table' });
        const mTh = tbl.createEl('thead').createEl('tr');
        mTh.createEl('th', { text: isRu ? 'Показатель' : 'Metric' });
        for (const wl of weekLabels) mTh.createEl('th', { text: wl });
        mTh.createEl('th', { text: isRu ? 'Средн.' : 'Avg' });
        const mTb = tbl.createEl('tbody');
        for (const [name, wMap] of moodWD) {
          const tr = mTb.createEl('tr');
          tr.createEl('td', { text: name });
          let sA = 0, cA = 0;
          for (let wi = 0; wi < weekLabels.length; wi++) {
            const e2 = wMap.get(wi);
            if (!e2) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              const av = Math.round((e2.sum / e2.count) * 10) / 10;
              const cl = av >= 7 ? 'planner-summary-good' : av <= 3 ? 'planner-summary-bad' : '';
              tr.createEl('td', { text: String(av), cls: `planner-summary-habit-cell ${cl}` });
              sA += e2.sum; cA += e2.count;
            }
          }
          const tA = cA > 0 ? Math.round((sA / cA) * 10) / 10 : 0;
          tr.createEl('td', { text: cA > 0 ? String(tA) : '—', cls: tA >= 7 ? 'planner-summary-good' : '' });
        }
      } else {
        moodSec.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }

    // ── Exercise by week ──
    {
      const exSec = row4moodMonthly.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const exH = exSec.createDiv({ cls: 'planner-weekly-block-header' });
      exH.createEl('h4', { text: `🏋️ ${isRu ? 'Тренировки по неделям' : 'Exercise by Week'}` });

      const exWD = new Map<string, Map<number, { total: number; unit: string }>>();
      for (let wi = 0; wi < weekRanges.length; wi++) {
        const wr = weekRanges[wi];
        for (const { data } of allDailyData.filter(d => d.day >= wr.start && d.day <= wr.end)) {
          for (const ex of data.exercise) {
            if (!exWD.has(ex.exercise)) exWD.set(ex.exercise, new Map());
            const wMap = exWD.get(ex.exercise)!;
            if (!wMap.has(wi)) wMap.set(wi, { total: 0, unit: ex.unit });
            wMap.get(wi)!.total += ex.value;
          }
        }
      }

      if (exWD.size > 0) {
        const tbl = exSec.createEl('table', { cls: 'planner-summary-table' });
        const eTh = tbl.createEl('thead').createEl('tr');
        eTh.createEl('th', { text: isRu ? 'Упражнение' : 'Exercise' });
        for (const wl of weekLabels) eTh.createEl('th', { text: wl });
        eTh.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const eTb = tbl.createEl('tbody');
        for (const [name, wMap] of exWD) {
          const tr = eTb.createEl('tr');
          tr.createEl('td', { text: name });
          let gT = 0;
          let u = '';
          for (let wi = 0; wi < weekLabels.length; wi++) {
            const e2 = wMap.get(wi);
            if (!e2) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              tr.createEl('td', { text: String(e2.total), cls: 'planner-summary-habit-cell' });
              gT += e2.total;
              if (!u) u = e2.unit;
            }
          }
          tr.createEl('td', { text: `${gT}${u ? ' ' + u : ''}` });
        }
      } else {
        exSec.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }
    // ═══════ ROW 5: Notes (full width) ═══════
    {
      const noteData: { day: string; task: string; note: string }[] = [];
      for (const { day } of allDailyData) {
        try {
          const block = dailyBlocks.find(b => b.day === day)!;
          const rawSchema = parseSchema(block.yaml);
          const expanded = rawSchema.template ? expandTemplate(rawSchema) : rawSchema;
          const sections = (expanded as PlannerSchema).sections;
          if (sections?.notes) {
            for (const n of sections.notes as Record<string, string | number | boolean>[]) {
              if (n.note) noteData.push({ day, task: n.task || '', note: n.note });
            }
          }
        } catch { /* skip */ }
      }

      const notesBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const hdr = notesBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📝 ${isRu ? 'Заметки' : 'Notes'}` });

      if (noteData.length > 0) {
        const tbl = notesBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Дата' : 'Date' });
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Заметка' : 'Note' });
        const tb = tbl.createEl('tbody');
        for (const n of noteData) {
          const tr = tb.createEl('tr');
          const noteDate = tr.createEl('td', { text: n.day.substring(5), cls: 'planner-weekly-day-label planner-clickable' });
          noteDate.addEventListener('click', () => this.navigateToDay(n.day));
          tr.createEl('td', { text: n.task });
          tr.createEl('td', { text: n.note });
        }
      } else {
        notesBlock.createEl('p', { text: isRu ? 'Нет заметок за этот месяц' : 'No notes for this month', cls: 'planner-weekly-no-data' });
      }
    }
  }

  /** Render dynamic yearly summary from daily planners */
  /** Render dynamic yearly dashboard from daily planners */
  private renderYearlySummary() {
    const year = this.nav.year!;
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;
    const dailyBlocks = this.getDailyBlocksForRange(startDate, endDate);
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const monthNames = getMonthNames();

    if (dailyBlocks.length === 0) return;

    // Parse all daily data
    const allDailyData: { day: string; data: ReturnType<typeof this.parseDailyData> }[] = [];
    for (const block of dailyBlocks) {
      allDailyData.push({ day: block.day!, data: this.parseDailyData(block) });
    }

    // Per-month aggregation
    const perMonth: {
      month: number;
      planners: number;
      tasks: number; doneTasks: number;
      habits: number; doneHabits: number;
      weeklyTasks: number; doneWeeklyTasks: number;
      monthlyTasks: number; doneMonthlyTasks: number;
      dailies: typeof allDailyData;
    }[] = [];

    let totalTasks = 0, doneTasks = 0, totalHabits = 0, doneHabits = 0;
    let totalWeeklyTasks = 0, doneWeeklyTasks = 0, totalMonthlyTasks = 0, doneMonthlyTasks = 0;

    for (let m = 1; m <= 12; m++) {
      const mp = String(m).padStart(2, '0');
      const mStart = `${year}-${mp}-01`;
      const daysInMonth = new Date(year, m, 0).getDate();
      const mEnd = `${year}-${mp}-${String(daysInMonth).padStart(2, '0')}`;
      const monthDailies = allDailyData.filter(d => d.day >= mStart && d.day <= mEnd);
      if (monthDailies.length === 0) continue;

      let mT = 0, mTD = 0, mH = 0, mHD = 0, mWT = 0, mWTD = 0;
      const monthlyTasksMap = new Map<string, boolean>();
      for (const { data } of monthDailies) {
        mT += data.tasks.length;
        mTD += data.tasks.filter(t => t.done).length;
        mH += data.habits.length;
        mHD += data.habits.filter(h => h.done).length;
        mWT += data.weeklyTasks.length;
        mWTD += data.weeklyTasks.filter(t => t.done).length;
        for (const t of data.monthlyTasks) {
          if (!t.task) continue;
          if (!monthlyTasksMap.has(t.task)) monthlyTasksMap.set(t.task, t.done);
          else if (t.done) monthlyTasksMap.set(t.task, true);
        }
      }
      const mMT = monthlyTasksMap.size;
      const mMTD = [...monthlyTasksMap.values()].filter(Boolean).length;

      perMonth.push({
        month: m, planners: monthDailies.length,
        tasks: mT, doneTasks: mTD, habits: mH, doneHabits: mHD,
        weeklyTasks: mWT, doneWeeklyTasks: mWTD,
        monthlyTasks: mMT, doneMonthlyTasks: mMTD,
        dailies: monthDailies,
      });
      totalTasks += mT; doneTasks += mTD;
      totalHabits += mH; doneHabits += mHD;
      totalWeeklyTasks += mWT; doneWeeklyTasks += mWTD;
      totalMonthlyTasks += mMT; doneMonthlyTasks += mMTD;
    }

    const dashboard = this.contentArea.createDiv({ cls: 'planner-weekly-dashboard' });
    dashboard.createEl('h3', { text: `📊 ${isRu ? 'Сводка за год' : 'Yearly Summary'}: ${year}` });

    // ═══════ STATS CARDS ═══════
    const statsRow = dashboard.createDiv({ cls: 'planner-monthly-stats' });
    const taskPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
    const habitPct = totalHabits > 0 ? Math.round((doneHabits / totalHabits) * 100) : 0;
    const weeklyPct = totalWeeklyTasks > 0 ? Math.round((doneWeeklyTasks / totalWeeklyTasks) * 100) : 0;
    const monthlyPct = totalMonthlyTasks > 0 ? Math.round((doneMonthlyTasks / totalMonthlyTasks) * 100) : 0;

    const makeCard = (icon: string, label: string, value: string, pct: number) => {
      const card = statsRow.createDiv({ cls: 'planner-monthly-stat-card' });
      card.createEl('div', { text: icon, cls: 'planner-monthly-stat-icon' });
      card.createEl('div', { text: label, cls: 'planner-monthly-stat-label' });
      card.createEl('div', { text: value, cls: 'planner-monthly-stat-value' });
      if (pct >= 0) {
        const bar = card.createDiv({ cls: 'planner-summary-progress-bar' });
        bar.createDiv({ cls: 'planner-summary-progress-fill' }).style.setProperty('--bar-width', `${pct}%`);
      }
    };
    makeCard('📅', isRu ? 'Планеров' : 'Planners', `${dailyBlocks.length}`, -1);
    makeCard('✅', isRu ? 'Ежедневные' : 'Daily Tasks', `${doneTasks}/${totalTasks} (${taskPct}%)`, taskPct);
    makeCard('🔄', isRu ? 'Привычки' : 'Habits', `${doneHabits}/${totalHabits} (${habitPct}%)`, habitPct);
    makeCard('🎯', isRu ? 'На неделю' : 'Weekly', `${doneWeeklyTasks}/${totalWeeklyTasks} (${weeklyPct}%)`, weeklyPct);
    if (totalMonthlyTasks > 0) {
      makeCard('📆', isRu ? 'На месяц' : 'Monthly', `${doneMonthlyTasks}/${totalMonthlyTasks} (${monthlyPct}%)`, monthlyPct);
    }

    // ═══════ ROW 1: Habits by month + Daily tasks by month ═══════
    const row1 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Habits by month ──
    {
      const hbSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = hbSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🔄 ${isRu ? 'Привычки по месяцам' : 'Habits by Month'}` });

      const habitMonthData = new Map<string, Map<number, { done: number; total: number }>>();
      for (const pm of perMonth) {
        for (const { data } of pm.dailies) {
          for (const h of data.habits) {
            if (!h.habit) continue;
            if (!habitMonthData.has(h.habit)) habitMonthData.set(h.habit, new Map());
            const mMap = habitMonthData.get(h.habit)!;
            if (!mMap.has(pm.month)) mMap.set(pm.month, { done: 0, total: 0 });
            const entry = mMap.get(pm.month)!;
            entry.total++;
            if (h.done) entry.done++;
          }
        }
      }

      if (habitMonthData.size > 0) {
        const activeMonths = perMonth.map(p => p.month);
        const tbl = hbSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Привычка' : 'Habit' });
        for (const m of activeMonths) th.createEl('th', { text: monthNames[m - 1].substring(0, 3) });
        th.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const tb = tbl.createEl('tbody');
        for (const [name, mMap] of habitMonthData) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: name });
          let sumD = 0, sumT = 0;
          for (const m of activeMonths) {
            const entry = mMap.get(m);
            if (!entry) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              const p = Math.round((entry.done / entry.total) * 100);
              tr.createEl('td', { text: `${p}%`, cls: `planner-summary-habit-cell ${p >= 70 ? 'planner-summary-good' : ''}` });
              sumD += entry.done; sumT += entry.total;
            }
          }
          const totalP = sumT > 0 ? Math.round((sumD / sumT) * 100) : 0;
          tr.createEl('td', { text: `${totalP}%`, cls: totalP >= 70 ? 'planner-summary-good' : '' });
        }
      }
    }

    // ── Daily tasks by month ──
    {
      const dtSection = row1.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = dtSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `✅ ${isRu ? 'Ежедневные задачи' : 'Daily Tasks'}` });

      const taskMonthData = new Map<string, Map<number, { done: number; total: number; priority: string; category: string }>>();
      for (const pm of perMonth) {
        for (const { data } of pm.dailies) {
          for (const t of data.tasks) {
            if (!t.task) continue;
            if (!taskMonthData.has(t.task)) taskMonthData.set(t.task, new Map());
            const mMap = taskMonthData.get(t.task)!;
            if (!mMap.has(pm.month)) mMap.set(pm.month, { done: 0, total: 0, priority: t.priority, category: t.category });
            const entry = mMap.get(pm.month)!;
            entry.total++;
            if (t.done) entry.done++;
          }
        }
      }

      if (taskMonthData.size > 0) {
        const activeMonths = perMonth.map(p => p.month);
        const tbl = dtSection.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        for (const m of activeMonths) th.createEl('th', { text: monthNames[m - 1].substring(0, 3) });
        th.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const tb = tbl.createEl('tbody');
        for (const [name, mMap] of taskMonthData) {
          const tr = tb.createEl('tr');
          tr.createEl('td', { text: name });
          const first = [...mMap.values()][0];
          tr.createEl('td', { text: first.priority });
          tr.createEl('td', { text: first.category });
          let sumD = 0, sumT = 0;
          for (const m of activeMonths) {
            const entry = mMap.get(m);
            if (!entry) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              const p = Math.round((entry.done / entry.total) * 100);
              tr.createEl('td', { text: `${p}%`, cls: `planner-summary-habit-cell ${p >= 70 ? 'planner-summary-good' : ''}` });
              sumD += entry.done; sumT += entry.total;
            }
          }
          const totalP = sumT > 0 ? Math.round((sumD / sumT) * 100) : 0;
          tr.createEl('td', { text: `${totalP}%`, cls: totalP >= 70 ? 'planner-summary-good' : '' });
        }
      }
    }

    // ═══════ ROW 2: Monthly tasks grouped by month ═══════
    {
      const row2 = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const hdr = row2.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📆 ${isRu ? 'Задачи на месяц' : 'Monthly Tasks'}` });

      let hasAnyTasks = false;
      for (const pm of perMonth) {
        const monthlyTasksMap = new Map<string, { priority: string; category: string; done: boolean; completedDate: string }>();
        for (const { data } of pm.dailies) {
          for (const t of data.monthlyTasks) {
            if (!t.task) continue;
            if (!monthlyTasksMap.has(t.task)) {
              monthlyTasksMap.set(t.task, { priority: t.priority, category: t.category, done: t.done, completedDate: t.completedDate });
            } else if (t.done) {
              const entry = monthlyTasksMap.get(t.task)!;
              entry.done = true;
              if (t.completedDate) entry.completedDate = t.completedDate;
            }
          }
        }
        if (monthlyTasksMap.size === 0) continue;
        hasAnyTasks = true;

        row2.createEl('h5', { text: monthNames[pm.month - 1], cls: 'planner-monthly-week-label' });
        const tbl = row2.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Приоритет' : 'Priority' });
        th.createEl('th', { text: isRu ? 'Категория' : 'Category' });
        th.createEl('th', { text: isRu ? 'Статус' : 'Status' });
        th.createEl('th', { text: isRu ? 'Завершено' : 'Completed' });
        const tb = tbl.createEl('tbody');
        for (const [name, entry] of monthlyTasksMap) {
          const tr = tb.createEl('tr');
          if (entry.done) tr.addClass('planner-weekly-done-row');
          tr.createEl('td', { text: name });
          tr.createEl('td', { text: entry.priority });
          tr.createEl('td', { text: entry.category });
          tr.createEl('td', { text: entry.done ? '✅' : '⬜', cls: 'planner-summary-habit-cell' });
          const dateCell = tr.createEl('td', { text: entry.completedDate, cls: 'planner-weekly-day-label' });
          if (entry.completedDate) {
            dateCell.addClass('planner-clickable');
            dateCell.addEventListener('click', () => this.navigateToDay(entry.completedDate));
          }
        }
      }
      if (!hasAnyTasks) {
        row2.createEl('p', { text: isRu ? 'Нет задач на месяц' : 'No monthly tasks', cls: 'planner-weekly-no-data' });
      }
    }

    // ═══════ ROW 3: Yearly heatmap (left) + Completion chart by month (right) ═══════
    const row3 = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Yearly heatmap (GitHub-style) ──
    {
      const hmSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = hmSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `🗓️ ${isRu ? 'Активность за год' : 'Yearly Activity'}` });

      const dayActivity = new Map<string, number>();
      for (const { day, data } of allDailyData) {
        let done = data.tasks.filter(t => t.done).length;
        done += data.habits.filter(h => h.done).length;
        done += data.weeklyTasks.filter(t => t.done).length;
        done += data.monthlyTasks.filter(t => t.done).length;
        dayActivity.set(day, done);
      }
      const maxActivity = Math.max(1, ...dayActivity.values());

      const cal = hmSection.createDiv({ cls: 'planner-yearly-heatmap' });

      // Month labels row
      const monthLabelsRow = cal.createDiv({ cls: 'planner-yearly-heatmap-months' });
      monthLabelsRow.createDiv({ cls: 'planner-yearly-heatmap-spacer' }); // space for day labels
      {
        const jan1 = new Date(year, 0, 1);
        let prevMonth = -1;
        const totalWeeks = 53;
        for (let w = 0; w < totalWeeks; w++) {
          const wDate = new Date(jan1.getTime());
          wDate.setDate(jan1.getDate() + w * 7);
          const curMonth = wDate.getMonth();
          if (curMonth !== prevMonth) {
            const label = monthLabelsRow.createDiv({ cls: 'planner-yearly-heatmap-month-label' });
            label.setText(monthNames[curMonth].substring(0, 3));
            prevMonth = curMonth;
          } else {
            monthLabelsRow.createDiv({ cls: 'planner-yearly-heatmap-month-empty' });
          }
        }
      }

      // Day labels + cells grid
      const dayLabels = isRu ? ['Пн', '', 'Ср', '', 'Пт', '', 'Вс'] : ['Mo', '', 'We', '', 'Fr', '', 'Su'];
      for (let dow = 0; dow < 7; dow++) {
        const row = cal.createDiv({ cls: 'planner-yearly-heatmap-row' });
        row.createDiv({ text: dayLabels[dow], cls: 'planner-yearly-heatmap-day-label' });

        // Walk through all weeks
        const jan1 = new Date(year, 0, 1);
        const jan1Dow = (jan1.getDay() + 6) % 7; // 0=Mon
        for (let w = 0; w < 53; w++) {
          const dayOffset = w * 7 + dow - jan1Dow;
          const cellDate = new Date(year, 0, 1 + dayOffset);
          if (cellDate.getFullYear() !== year) {
            row.createDiv({ cls: 'planner-yearly-heatmap-cell planner-yearly-heatmap-empty' });
            continue;
          }
          const mm = String(cellDate.getMonth() + 1).padStart(2, '0');
          const dd = String(cellDate.getDate()).padStart(2, '0');
          const dateStr = `${year}-${mm}-${dd}`;
          const activity = dayActivity.get(dateStr) || 0;
          const hasPlanner = dayActivity.has(dateStr);

          const cell = row.createDiv({ cls: 'planner-yearly-heatmap-cell' });
          if (hasPlanner) {
            const intensity = Math.round((activity / maxActivity) * 4);
            cell.addClass(`planner-heatmap-level-${Math.min(intensity, 4)}`);
          } else {
            cell.addClass('planner-heatmap-no-data');
          }
          cell.setAttribute('title', hasPlanner ? `${dateStr}: ${activity} ${isRu ? 'выполнено' : 'done'}` : dateStr);
          cell.addEventListener('click', () => this.navigateToDay(dateStr));
        }
      }

      // Legend
      const legend = cal.createDiv({ cls: 'planner-yearly-heatmap-legend' });
      legend.createEl('span', { text: isRu ? 'Меньше' : 'Less' });
      for (let i = 0; i <= 4; i++) {
        legend.createDiv({ cls: `planner-yearly-heatmap-cell planner-heatmap-level-${i}` });
      }
      legend.createEl('span', { text: isRu ? 'Больше' : 'More' });
    }

    // ── Completion chart by month ──
    {
      const chartSection = row3.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const hdr = chartSection.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📊 ${isRu ? 'Выполнение по месяцам' : 'Completion by Month'}` });

      const chartArea = chartSection.createDiv({ cls: 'planner-monthly-chart' });
      for (const pm of perMonth) {
        const tPct = pm.tasks > 0 ? Math.round((pm.doneTasks / pm.tasks) * 100) : 0;
        const hPct = pm.habits > 0 ? Math.round((pm.doneHabits / pm.habits) * 100) : 0;

        const barGroup = chartArea.createDiv({ cls: 'planner-chart-bar-group' });
        barGroup.createEl('div', { text: monthNames[pm.month - 1].substring(0, 3), cls: 'planner-chart-label' });
        const barsRow = barGroup.createDiv({ cls: 'planner-chart-bars' });
        const taskBar = barsRow.createDiv({ cls: 'planner-chart-bar planner-chart-bar-tasks' });
        taskBar.createDiv({ cls: 'planner-chart-bar-fill' }).style.setProperty('--bar-width', `${tPct}%`);
        taskBar.setAttribute('title', `${isRu ? 'Задачи' : 'Tasks'}: ${tPct}%`);
        taskBar.createEl('span', { text: `${tPct}%`, cls: 'planner-chart-bar-text' });
        const habitBar = barsRow.createDiv({ cls: 'planner-chart-bar planner-chart-bar-habits' });
        habitBar.createDiv({ cls: 'planner-chart-bar-fill' }).style.setProperty('--bar-width', `${hPct}%`);
        habitBar.setAttribute('title', `${isRu ? 'Привычки' : 'Habits'}: ${hPct}%`);
        habitBar.createEl('span', { text: `${hPct}%`, cls: 'planner-chart-bar-text' });
      }
      const legend = chartArea.createDiv({ cls: 'planner-chart-legend' });
      const l1 = legend.createDiv({ cls: 'planner-chart-legend-item' });
      l1.createDiv({ cls: 'planner-chart-legend-color planner-chart-bar-tasks' });
      l1.createEl('span', { text: isRu ? 'Задачи' : 'Tasks' });
      const l2 = legend.createDiv({ cls: 'planner-chart-legend-item' });
      l2.createDiv({ cls: 'planner-chart-legend-color planner-chart-bar-habits' });
      l2.createEl('span', { text: isRu ? 'Привычки' : 'Habits' });
    }


    // ═══════ ROW 4: Mood + Exercise by month ═══════
    const row4moodYearly = dashboard.createDiv({ cls: 'planner-weekly-row' });

    // ── Mood by month ──
    {
      const moodSec = row4moodYearly.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const moodH = moodSec.createDiv({ cls: 'planner-weekly-block-header' });
      moodH.createEl('h4', { text: `🌟 ${isRu ? 'Самочувствие по месяцам' : 'Mood by Month'}` });

      const moodMonthData = new Map<string, Map<number, { sum: number; count: number }>>();
      for (const pm of perMonth) {
        for (const { data } of pm.dailies) {
          for (const m of data.mood) {
            if (!moodMonthData.has(m.metric)) moodMonthData.set(m.metric, new Map());
            const mMap = moodMonthData.get(m.metric)!;
            if (!mMap.has(pm.month)) mMap.set(pm.month, { sum: 0, count: 0 });
            const e2 = mMap.get(pm.month)!;
            e2.sum += m.value; e2.count++;
          }
        }
      }

      if (moodMonthData.size > 0) {
        const activeMonths = perMonth.map(p => p.month);
        const tbl = moodSec.createEl('table', { cls: 'planner-summary-table' });
        const mTh = tbl.createEl('thead').createEl('tr');
        mTh.createEl('th', { text: isRu ? 'Показатель' : 'Metric' });
        for (const m of activeMonths) mTh.createEl('th', { text: monthNames[m - 1].substring(0, 3) });
        mTh.createEl('th', { text: isRu ? 'Средн.' : 'Avg' });
        const mTb = tbl.createEl('tbody');
        for (const [name, mMap] of moodMonthData) {
          const tr = mTb.createEl('tr');
          tr.createEl('td', { text: name });
          let sA = 0, cA = 0;
          for (const m of activeMonths) {
            const e2 = mMap.get(m);
            if (!e2) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              const av = Math.round((e2.sum / e2.count) * 10) / 10;
              const cl = av >= 7 ? 'planner-summary-good' : av <= 3 ? 'planner-summary-bad' : '';
              tr.createEl('td', { text: String(av), cls: `planner-summary-habit-cell ${cl}` });
              sA += e2.sum; cA += e2.count;
            }
          }
          const tA = cA > 0 ? Math.round((sA / cA) * 10) / 10 : 0;
          tr.createEl('td', { text: cA > 0 ? String(tA) : '—', cls: tA >= 7 ? 'planner-summary-good' : '' });
        }
      } else {
        moodSec.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }

    // ── Exercise by month ──
    {
      const exSec = row4moodYearly.createDiv({ cls: 'planner-weekly-block planner-weekly-row-item' });
      const exH = exSec.createDiv({ cls: 'planner-weekly-block-header' });
      exH.createEl('h4', { text: `🏋️ ${isRu ? 'Тренировки по месяцам' : 'Exercise by Month'}` });

      const exMonthData = new Map<string, Map<number, { total: number; unit: string }>>();
      for (const pm of perMonth) {
        for (const { data } of pm.dailies) {
          for (const ex of data.exercise) {
            if (!exMonthData.has(ex.exercise)) exMonthData.set(ex.exercise, new Map());
            const mMap = exMonthData.get(ex.exercise)!;
            if (!mMap.has(pm.month)) mMap.set(pm.month, { total: 0, unit: ex.unit });
            mMap.get(pm.month)!.total += ex.value;
          }
        }
      }

      if (exMonthData.size > 0) {
        const activeMonths = perMonth.map(p => p.month);
        const tbl = exSec.createEl('table', { cls: 'planner-summary-table' });
        const eTh = tbl.createEl('thead').createEl('tr');
        eTh.createEl('th', { text: isRu ? 'Упражнение' : 'Exercise' });
        for (const m of activeMonths) eTh.createEl('th', { text: monthNames[m - 1].substring(0, 3) });
        eTh.createEl('th', { text: isRu ? 'Итого' : 'Total' });
        const eTb = tbl.createEl('tbody');
        for (const [name, mMap] of exMonthData) {
          const tr = eTb.createEl('tr');
          tr.createEl('td', { text: name });
          let gT = 0;
          let u = '';
          for (const m of activeMonths) {
            const e2 = mMap.get(m);
            if (!e2) {
              tr.createEl('td', { text: '—', cls: 'planner-summary-habit-cell planner-weekly-no-data' });
            } else {
              tr.createEl('td', { text: String(e2.total), cls: 'planner-summary-habit-cell' });
              gT += e2.total;
              if (!u) u = e2.unit;
            }
          }
          tr.createEl('td', { text: `${gT}${u ? ' ' + u : ''}` });
        }
      } else {
        exSec.createEl('p', { text: isRu ? 'Нет данных' : 'No data', cls: 'planner-weekly-no-data' });
      }
    }
    // ═══════ ROW 5: Notes (full width) ═══════
    {
      const noteData: { day: string; task: string; note: string }[] = [];
      for (const { day } of allDailyData) {
        try {
          const block = dailyBlocks.find(b => b.day === day)!;
          const rawSchema = parseSchema(block.yaml);
          const expanded = rawSchema.template ? expandTemplate(rawSchema) : rawSchema;
          const sections = (expanded as PlannerSchema).sections;
          if (sections?.notes) {
            for (const n of sections.notes as Record<string, string | number | boolean>[]) {
              if (n.note) noteData.push({ day, task: n.task || '', note: n.note });
            }
          }
        } catch { /* skip */ }
      }

      const notesBlock = dashboard.createDiv({ cls: 'planner-weekly-block' });
      const hdr = notesBlock.createDiv({ cls: 'planner-weekly-block-header' });
      hdr.createEl('h4', { text: `📝 ${isRu ? 'Заметки' : 'Notes'}` });

      if (noteData.length > 0) {
        const tbl = notesBlock.createEl('table', { cls: 'planner-summary-table' });
        const th = tbl.createEl('thead').createEl('tr');
        th.createEl('th', { text: isRu ? 'Дата' : 'Date' });
        th.createEl('th', { text: isRu ? 'Задача' : 'Task' });
        th.createEl('th', { text: isRu ? 'Заметка' : 'Note' });
        const tb = tbl.createEl('tbody');
        for (const n of noteData) {
          const tr = tb.createEl('tr');
          const noteDate = tr.createEl('td', { text: n.day.substring(5), cls: 'planner-weekly-day-label planner-clickable' });
          noteDate.addEventListener('click', () => this.navigateToDay(n.day));
          tr.createEl('td', { text: n.task });
          tr.createEl('td', { text: n.note });
        }
      } else {
        notesBlock.createEl('p', { text: isRu ? 'Нет заметок за этот год' : 'No notes for this year', cls: 'planner-weekly-no-data' });
      }
    }
  }

  /** Inject dictionary overrides into template YAML for new files */
  private injectDictionaries(yaml: string, templateKey: string): string {
    const dict = this.config.dictionaries;
    const lines: string[] = [];
    if (templateKey === 'daily-planner') {
      if (dict['planner-categories']?.length) lines.push(`categories:\n${dict['planner-categories'].map(c => `  - "${c}"`).join('\n')}`);
      if (dict['planner-weekly-priorities']?.length) lines.push(`weeklyPriorities:\n${dict['planner-weekly-priorities'].map(c => `  - "${c}"`).join('\n')}`);
      if (dict['planner-daily-priorities']?.length) lines.push(`dailyPriorities:\n${dict['planner-daily-priorities'].map(c => `  - "${c}"`).join('\n')}`);
    } else if (templateKey === 'daily-finance') {
      if (dict['finance-fixed-categories']?.length) lines.push(`fixedCategories:\n${dict['finance-fixed-categories'].map(c => `  - "${c}"`).join('\n')}`);
      if (dict['finance-variable-categories']?.length) lines.push(`variableCategories:\n${dict['finance-variable-categories'].map(c => `  - "${c}"`).join('\n')}`);
    } else if (templateKey === 'goal-tracker') {
      if (dict['goal-statuses']?.length) lines.push(`statuses:\n${dict['goal-statuses'].map(c => `  - "${c}"`).join('\n')}`);
    } else if (templateKey === 'project-tracker') {
      if (dict['project-statuses']?.length) lines.push(`statuses:\n${dict['project-statuses'].map(c => `  - "${c}"`).join('\n')}`);
      if (dict['project-priorities']?.length) lines.push(`priorities:\n${dict['project-priorities'].map(c => `  - "${c}"`).join('\n')}`);
    } else if (templateKey === 'reading-log') {
      if (dict['reading-statuses']?.length) lines.push(`statuses:\n${dict['reading-statuses'].map(c => `  - "${c}"`).join('\n')}`);
    }
    if (lines.length === 0) return yaml;
    return yaml + '\n' + lines.join('\n');
  }

  private async addPlannerToBoard(templateKey: string) {
    // For daily planner not at day level, prompt for date first
    if (templateKey === 'daily-planner' && !this.nav.day) {
      new DailyDatePickerModal(this.app, (selectedDay: string) => {
        void this.createDailyPlannerForDay(selectedDay);
      }).open();
      return;
    }

    const day = templateKey === 'daily-planner' ? this.nav.day : undefined;
    if (templateKey === 'daily-planner' && day) {
      await this.createDailyPlannerForDay(day);
      return;
    }

    // Non-daily planner creation
    const templates = this.plugin.getTemplates();
    const tmpl = templates[templateKey];
    if (!tmpl) return;
    const subFolder = this.config.templateFolders[templateKey] || templateKey;
    const targetFolder = `${this.config.folder}/${subFolder}`;
    const parts = targetFolder.split('/');
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
    }
    let month: string | undefined;
    if (this.nav.year && this.nav.month) {
      month = `${this.nav.year}-${String(this.nav.month).padStart(2, '0')}`;
    } else if (this.nav.year) {
      month = String(this.nav.year);
    }
    const yaml = this.injectDictionaries(tmpl.generator(this.plugin.settings, month), templateKey);
    const content = '```planner\n' + yaml + '\n```\n';
    let baseName: string;
    if (month && month.includes('-')) {
      const [y, m] = month.split('-');
      baseName = `${getMonthNames()[parseInt(m) - 1]} ${y}`;
    } else if (month) {
      baseName = `${tmpl.label.replace(/[^\w\s\-а-яА-ЯёЁ]/gu, '').trim()} ${month}`;
    } else {
      baseName = tmpl.label.replace(/[^\w\s\-а-яА-ЯёЁ]/gu, '').trim();
    }
    let fileName = `${targetFolder}/${baseName}.planner`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = `${targetFolder}/${baseName} ${counter}.planner`;
      counter++;
    }
    await this.app.vault.create(fileName, content);
    new Notice(t('notice.plannerCreated', { name: fileName }));
    await this.refresh();
  }

  /** Create a daily planner file for a specific day */
  private async createDailyPlannerForDay(day: string) {
    const templates = this.plugin.getTemplates();
    const tmpl = templates['daily-planner'];
    if (!tmpl) return;
    const subFolder = this.config.templateFolders['daily-planner'] || 'daily-planner';
    const [dy, dm] = day.split('-');
    const monthName = getMonthNames()[parseInt(dm) - 1];
    const targetFolder = `${this.config.folder}/${subFolder}/${monthName} ${dy}`;
    const parts = targetFolder.split('/');
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
    }
    const month = `${dy}-${dm}`;
    let templateYaml = this.injectDictionaries(tmpl.generator(this.plugin.settings, month), 'daily-planner');
    templateYaml = templateYaml.replace(/month:\s*\S+/, `day: "${day}"`);

    // Merge template defaults (pre-filled habits, etc.)
    if (this.config.templateDefaults['daily-planner']) {
      try {
        const defaultSchema = parseSchema(this.config.templateDefaults['daily-planner']);
        const defaultExpanded = defaultSchema.template ? expandTemplate(defaultSchema) : defaultSchema;
        const defaultSections = (defaultExpanded as PlannerSchema).sections;
        if (defaultSections) {
          const schema = parseSchema(templateYaml);
          const sections = (schema as PlannerSchema).sections || {};
          for (const [key, data] of Object.entries(defaultSections)) {
            if (Array.isArray(data) && data.length > 0) {
              const hasContent = data.some((row: Record<string, string | number | boolean>) => Object.values(row).some(v => v !== '' && v !== 0 && v !== false && v !== null && v !== undefined));
              if (hasContent) sections[key] = data;
            }
          }
          (schema as PlannerSchema).sections = sections;
          templateYaml = serializeSchema(schema);
        }
      } catch { /* use default template */ }
    }

    // Carry over unfinished tasks + weekly tasks from previous day / same week
    const carryOver = this.getCarryOverData(day);
    if (carryOver) {
      const schema = parseSchema(templateYaml);
      const sections = (schema as PlannerSchema).sections || {};
      if (carryOver.tasks.length > 0) {
        sections.tasks = [...carryOver.tasks, { done: false, task: '', priority: '', category: '' }];
      }
      if (carryOver.weeklyTasks.length > 0) {
        sections.weeklyTasks = [...carryOver.weeklyTasks, { done: false, task: '', priority: '', category: '', completedDate: '' }];
      }
      if (carryOver.habits.length > 0) {
        sections.habits = [...carryOver.habits, { habit: '', description: '', done: false }];
      }
      (schema as PlannerSchema).sections = sections;
      templateYaml = serializeSchema(schema);
    }

    const content = '```planner\n' + templateYaml + '\n```\n';
    let fileName = `${targetFolder}/${day}.planner`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = `${targetFolder}/${day} ${counter}.planner`;
      counter++;
    }
    await this.app.vault.create(fileName, content);
    new Notice(t('notice.plannerCreated', { name: fileName }));
    await this.refresh();
  }

  /** Get carry-over data: unfinished tasks from previous day + weekly tasks & habits from the same week */
  private getCarryOverData(day: string): {
    tasks: { done: boolean; task: string; priority: string; category: string }[];
    weeklyTasks: { done: boolean; task: string; priority: string; category: string; completedDate: string }[];
    habits: { habit: string; description: string; done: boolean }[];
  } | null {
    // Find previous day's planner
    const prevDate = new Date(day);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${String(prevDate.getDate()).padStart(2, '0')}`;

    // Find all daily blocks in the same week
    const date = new Date(day);
    const week = getISOWeek(date);
    const year = date.getFullYear();
    const weekDays = getDaysInWeek(year, week);
    const weekBlocks = this.getDailyBlocksForRange(weekDays[0].date, weekDays[6].date);

    const result = {
      tasks: [] as { done: boolean; task: string; priority: string; category: string }[],
      weeklyTasks: [] as { done: boolean; task: string; priority: string; category: string; completedDate: string }[],
      habits: [] as { habit: string; description: string; done: boolean }[],
    };

    // Carry over unfinished tasks from previous day
    const prevBlock = weekBlocks.find(b => b.day === prevStr);
    if (prevBlock) {
      try {
        const schema = parseSchema(prevBlock.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const sections = (expanded as PlannerSchema).sections;
        if (sections?.tasks) {
          for (const t of sections.tasks as Record<string, string | number | boolean>[]) {
            if (t.task && !t.done) {
              result.tasks.push({ done: false, task: t.task, priority: t.priority || '', category: t.category || '' });
            }
          }
        }
      } catch { /* skip */ }
    }

    // Also collect daily tasks from ALL dailies in the week (sync across days)
    const seenTasks = new Set(result.tasks.map(t => t.task));
    for (const block of weekBlocks) {
      if (block.day === prevStr || block.day === day) continue;
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const sections = (expanded as PlannerSchema).sections;
        if (sections?.tasks) {
          for (const t of sections.tasks as Record<string, string | number | boolean>[]) {
            if (t.task && !seenTasks.has(t.task)) {
              seenTasks.add(t.task);
              result.tasks.push({ done: false, task: t.task, priority: t.priority || '', category: t.category || '' });
            }
          }
        }
      } catch { /* skip */ }
    }

    // Collect weekly tasks and habits from all dailies in the week
    const allWeeklyTasks = new Map<string, { done: boolean; task: string; priority: string; category: string; completedDate: string }>();
    const allHabits = new Map<string, { habit: string; description: string }>();

    for (const block of weekBlocks) {
      try {
        const schema = parseSchema(block.yaml);
        const expanded = schema.template ? expandTemplate(schema) : schema;
        const sections = (expanded as PlannerSchema).sections;
        if (sections?.weeklyTasks) {
          for (const t of sections.weeklyTasks as Record<string, string | number | boolean>[]) {
            if (t.task) {
              const existing = allWeeklyTasks.get(t.task);
              if (!existing || (t.done && !existing.done)) {
                allWeeklyTasks.set(t.task, {
                  done: t.done || false, task: t.task,
                  priority: t.priority || existing?.priority || '',
                  completedDate: t.completedDate || existing?.completedDate || '',
                });
              }
            }
          }
        }
        if (sections?.habits) {
          for (const h of sections.habits as Record<string, string | number | boolean>[]) {
            if (h.habit && !allHabits.has(h.habit)) {
              allHabits.set(h.habit, { habit: h.habit, description: h.description || '' });
            }
          }
        }
      } catch { /* skip */ }
    }

    for (const [, t] of allWeeklyTasks) {
      result.weeklyTasks.push(t);
    }
    for (const [, h] of allHabits) {
      result.habits.push({ ...h, done: false });
    }

    if (result.tasks.length === 0 && result.weeklyTasks.length === 0 && result.habits.length === 0) return null;
    return result;
  }

  private showAddMonthMenu(evt: Event) {
    const menu = new Menu();
    const now = new Date();
    const targetYear = this.nav.year || now.getFullYear();
    const existing = this.getMonthsForYear(targetYear);
    for (let m = 1; m <= 12; m++) {
      if (existing.includes(m)) continue;
      menu.addItem(item => {
        item.setTitle(`${getMonthNames()[m - 1]} ${targetYear}`).setIcon('calendar')
          .onClick(() => this.navigate({ level: 'month', year: targetYear, month: m }));
      });
    }
    if (evt instanceof MouseEvent) menu.showAtMouseEvent(evt);
  }

  async onClose() {
    this.contentArea?.empty();
    this.tabBar?.empty();
    this.headerEl?.empty();
    this.breadcrumbEl?.empty();
  }
}

/**
 * Date picker modal for creating a daily planner when not at day nav level.
 */
class DailyDatePickerModal extends Modal {
  private onSelect: (day: string) => void;

  constructor(app: App, onSelect: (day: string) => void) {
    super(app);
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('board.selectDateForDaily') });
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const defaultVal = `${yyyy}-${mm}-${dd}`;

    const input = contentEl.createEl('input', { type: 'date' });
    input.value = defaultVal;
    input.addClass('planner-date-input-full');

    const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const btn = btnContainer.createEl('button', { text: t('ui.create'), cls: 'mod-cta' });
    btn.addEventListener('click', () => {
      const val = input.value;
      if (val) {
        this.close();
        this.onSelect(val);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Full-page view for individual .planner files.
 * Renders the planner YAML block fullscreen with live editing.
 */
export class PlannerFileView extends TextFileView {
  private plugin: PlannerBoardsPlugin;
  private headerEl: HTMLElement;
  private contentArea: HTMLElement;
  private suppressRender = false;

  constructor(leaf: WorkspaceLeaf, plugin: PlannerBoardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PLANNER_FILE;
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (this.suppressRender) {
      this.suppressRender = false;
      return;
    }
    // Build/rebuild header whenever file data loads (file is available at this point)
    if (this.headerEl) {
      this.buildNavHeader(this.headerEl);
    }
    this.renderPlanner();
  }

  clear(): void {
    this.contentArea?.empty();
  }

  getIcon(): string {
    return 'file-check';
  }

  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('planner-file-root');

    this.headerEl = root.createDiv({ cls: 'planner-file-header' });
    this.contentArea = root.createDiv({ cls: 'planner-file-content planner-boards-root' });
  }

  private findBoardFile(): TFile | null {
    const filePath = this.file?.path || '';
    // Walk up the directory tree looking for a .md file with planner-board frontmatter
    const parts = filePath.split('/');
    for (let i = parts.length - 2; i >= 0; i--) {
      const dirPath = parts.slice(0, i + 1).join('/');
      const folder = this.app.vault.getAbstractFileByPath(dirPath);
      if (folder && folder instanceof TFolder) {
        for (const child of folder.children) {
          if (child instanceof TFile && child.extension === 'md') {
            // Check if it's a board file by looking in open leaves
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD);
            for (const leaf of leaves) {
              if ((leaf.view as TextFileView).file?.path === child.path) return child;
            }
          }
        }
      }
    }
    // Fallback: find any open board leaf
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD);
    if (leaves.length > 0) return (leaves[0].view as TextFileView).file ?? null;
    return null;
  }

  private buildNavHeader(header: HTMLElement) {
    header.empty();
    const breadcrumb = header.createDiv({ cls: 'planner-board-breadcrumb' });
    const fileName = this.file?.basename || '';

    if (!fileName) {
      breadcrumb.createSpan({ text: t('board.defaultPlannerTitle'), cls: 'planner-breadcrumb-current' });
      return;
    }

    const addCrumb = (text: string, onClick?: () => void) => {
      if (breadcrumb.childElementCount > 0)
        breadcrumb.createSpan({ text: ' ▸ ', cls: 'planner-breadcrumb-sep' });
      const s = breadcrumb.createEl('span', { text, cls: 'planner-breadcrumb-item' });
      if (onClick) { s.addClass('planner-breadcrumb-link'); s.addEventListener('click', onClick); }
      else s.addClass('planner-breadcrumb-current');
    };

    // Board link
    const boardFile = this.findBoardFile();
    if (boardFile) {
      addCrumb('📋 ' + boardFile.basename, () => {
        void this.app.workspace.openLinkText(boardFile.path, '');
      });
    }

    // Parse date context from filename
    const dayMatch = fileName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dayMatch) {
      const [, y, m, d] = dayMatch;
      const monthName = getMonthNames()[parseInt(m) - 1];
      addCrumb(`${monthName} ${y}`);

      const dd = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      const dayName = getDayNames()[dd.getDay()];
      addCrumb(`${parseInt(d)} ${dayName}`);

      // Prev/Next day buttons
      const btnRow = header.createDiv({ cls: 'planner-file-nav-buttons' });
      const currentDate = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));

      const prevDate = new Date(currentDate);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${String(prevDate.getDate()).padStart(2, '0')}`;
      const prevBtn = btnRow.createEl('button', { text: `← ${prevStr}`, cls: 'planner-file-nav-btn' });
      prevBtn.addEventListener('click', () => this.navigateToDay(prevStr));

      const nextDate = new Date(currentDate);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
      const nextBtn = btnRow.createEl('button', { text: `${nextStr} →`, cls: 'planner-file-nav-btn' });
      nextBtn.addEventListener('click', () => this.navigateToDay(nextStr));
    } else {
      addCrumb(fileName);
    }
  }

  private navigateToDay(dateStr: string) {
    const filePath = this.file?.path || '';
    // Derive daily-planner base dir from current file path
    // Expected structure: .../daily-planner/MonthName YYYY/YYYY-MM-DD.planner
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/')); // month folder
    const dailyDir = parentDir.substring(0, parentDir.lastIndexOf('/')); // daily-planner folder

    const [y, m] = dateStr.split('-');
    const monthName = getMonthNames()[parseInt(m) - 1];
    const targetPath = `${dailyDir}/${monthName} ${y}/${dateStr}.planner`;
    const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (targetFile) {
      void this.app.workspace.openLinkText(targetPath, '');
    } else {
      new Notice(t('board.noDailyForDate', { date: dateStr }));
    }
  }

  private renderPlanner() {
    if (!this.contentArea) return;
    this.contentArea.empty();

    const regex = /```planner\n([\s\S]*?)```/g;
    let match;
    let found = false;
    while ((match = regex.exec(this.data)) !== null) {
      found = true;
      const rawYaml = match[1]; // keep raw for accurate replacement
      const yaml = rawYaml.trim();
      let originalRaw = rawYaml;
      const card = this.contentArea.createDiv({ cls: 'planner-view-card' });

      const cardBody = card.createDiv({ cls: 'planner-view-card-body planner-boards-root' });
      createPlanner(yaml, cardBody, {
        suppressTitle: true,
        onAddItem: (subtableTitle: string) => {
          const type = this.resolveSubtableType(subtableTitle);
          if (!type) return;
          if (type === 'notes') {
            this.addNoteModal();
            return;
          }
          if (type === 'mood') {
            this.addMoodModalFile();
            return;
          }
          if (type === 'exercise') {
            this.addExerciseModalFile();
            return;
          }
          this.addItemModal(type);
        },
        onDataChange: async (newYaml: string) => {
          if (!this.file) return;
          const content = this.data;
          const searchStr = '```planner\n' + originalRaw + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            this.data = newContent;
            originalRaw = newYaml + '\n';
            this.suppressRender = true;
            this.requestSave();
            // Sync habits across daily planners in the same week
            const dayMatch = this.file?.basename?.match(/^(\d{4}-\d{2}-\d{2})$/);
            if (dayMatch) {
              await this.syncWeeklyData(dayMatch[1], newYaml);
              await this.syncMonthlyData(dayMatch[1], newYaml);
            }
          }
        },
      });
    }

    if (!found) {
      this.contentArea.createEl('p', { text: t('main.noBlocksInFile'), cls: 'planner-view-no-events' });
    }
  }

  private resolveSubtableType(title: string): 'weeklyTasks' | 'monthlyTasks' | 'habits' | 'dailyTasks' | 'notes' | 'mood' | 'exercise' | null {
    if (title.includes('Привычки') || title.includes('Habits')) return 'habits';
    if (title.includes('Задачи на месяц') || title.includes('Monthly Tasks')) return 'monthlyTasks';
    if (title.includes('Задачи на неделю') || title.includes('Weekly Tasks')) return 'weeklyTasks';
    if (title.includes('Ежедневные') || title.includes('Daily')) return 'dailyTasks';
    if (title.includes('Заметки') || title.includes('Notes')) return 'notes';
    if (title.includes('Самочувствие') || title.includes('Mood')) return 'mood';
    if (title.includes('Тренировки') || title.includes('Exercise')) return 'exercise';
    return null;
  }

  private addItemModal(type: 'weeklyTasks' | 'monthlyTasks' | 'habits' | 'dailyTasks') {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    const titles: Record<string, string> = {
      weeklyTasks: isRu ? 'Добавить задачу на неделю' : 'Add weekly task',
      monthlyTasks: isRu ? 'Добавить задачу на месяц' : 'Add monthly task',
      dailyTasks: isRu ? 'Добавить ежедневную задачу' : 'Add daily task',
      habits: isRu ? 'Добавить привычку' : 'Add habit',
    };
    modal.titleEl.setText(titles[type]);
    const contentEl = modal.contentEl;
    let nameVal = '';
    let descVal = '';
    let priorityVal = '';
    let categoryVal = '';

    new Setting(contentEl)
      .setName(type === 'habits' ? (isRu ? 'Привычка' : 'Habit') : (isRu ? 'Задача' : 'Task'))
      .addText(txt => txt.onChange(v => nameVal = v));

    if (type === 'habits') {
      new Setting(contentEl)
        .setName(isRu ? 'Описание' : 'Description')
        .addText(txt => txt.onChange(v => descVal = v));
    } else {
      const priorities = (type === 'weeklyTasks' || type === 'monthlyTasks')
        ? (isRu
          ? ['🔴 Срочно / Важно', '🟡 Не срочно / Важно', '🟠 Срочно / Не важно', '🟢 Не срочно / Не важно']
          : ['🔴 Urgent / Important', '🟡 Not Urgent / Important', '🟠 Urgent / Not Important', '🟢 Not Urgent / Not Important'])
        : (isRu
          ? ['🔴 Важно', '🟡 Средне', '🟢 Не важно']
          : ['🔴 Important', '🟡 Medium', '🟢 Not Important']);
      new Setting(contentEl)
        .setName(isRu ? 'Приоритет' : 'Priority')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const p of priorities) dd.addOption(p, p);
          dd.onChange(v => priorityVal = v);
        });
      const categories = isRu
        ? ['Работа', 'Личное', 'Здоровье', 'Учёба', 'Другое']
        : ['Work', 'Personal', 'Health', 'Study', 'Other'];
      new Setting(contentEl)
        .setName(isRu ? 'Категория' : 'Category')
        .addDropdown(dd => {
          dd.addOption('', '—');
          for (const c of categories) dd.addOption(c, c);
          dd.onChange(v => categoryVal = v);
        });
    }

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!nameVal.trim()) return;
        modal.close();
        // Add to current file's YAML
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(this.data);
        if (!match) return;
        const rawYaml = match[1].trim();
        try {
          const schema = parseSchema(rawYaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (type === 'weeklyTasks' || type === 'monthlyTasks') {
            const key = type === 'monthlyTasks' ? 'monthlyTasks' : 'weeklyTasks';
            if (!sections[key]) sections[key] = [];
            sections[key] = sections[key].filter((t: Record<string, string | number | boolean>) => t.task);
            sections[key].push({ done: false, task: nameVal, priority: priorityVal, category: categoryVal, completedDate: '' });
            sections[key].push({ done: false, task: '', priority: '', category: '', completedDate: '' });
          } else if (type === 'dailyTasks') {
            if (!sections.tasks) sections.tasks = [];
            sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.tasks.push({ done: false, task: nameVal, priority: priorityVal, category: categoryVal });
            sections.tasks.push({ done: false, task: '', priority: '', category: '' });
          } else {
            if (!sections.habits) sections.habits = [];
            sections.habits = sections.habits.filter((h: Record<string, string | number | boolean>) => h.habit);
            sections.habits.push({ habit: nameVal, description: descVal, done: false });
            sections.habits.push({ habit: '', description: '', done: false });
          }
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          this.data = this.data.replace(searchStr, replaceStr);
          this.suppressRender = true;
          this.requestSave();
          const dayMatch = this.file?.basename?.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (dayMatch) {
            await this.syncWeeklyData(dayMatch[1], newYaml);
            await this.syncMonthlyData(dayMatch[1], newYaml);
          }
          this.renderPlanner();
        } catch { /* skip */ }
      }));
    modal.open();
  }

  /** Add a note to the current planner file */
  private addNoteModal() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить заметку' : 'Add note');
    const contentEl = modal.contentEl;
    let taskVal = '';
    let noteVal = '';

    // Collect all task names from the planner
    const taskNames: string[] = [];
    const regex = /```planner\n([\s\S]*?)```/;
    const m = regex.exec(this.data);
    if (m) {
      try {
        const schema = parseSchema(m[1].trim());
        const sections = (schema as PlannerSchema).sections || {};
        for (const key of ['tasks', 'weeklyTasks', 'monthlyTasks']) {
          const arr = sections[key] as Record<string, string | number | boolean>[] | undefined;
          if (arr) arr.forEach((t: Record<string, string | number | boolean>) => { if ((t.task as string)?.trim()) taskNames.push((t.task as string).trim()); });
        }
      } catch { /* skip */ }
    }

    new Setting(contentEl)
      .setName(isRu ? 'Задача' : 'Task')
      .addDropdown(dd => {
        dd.addOption('', isRu ? '— выбрать —' : '— select —');
        taskNames.forEach(name => dd.addOption(name, name));
        dd.onChange(v => taskVal = v);
      });
    new Setting(contentEl)
      .setName(isRu ? 'Заметка' : 'Note')
      .addText(txt => txt.onChange(v => noteVal = v));

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!noteVal.trim()) return;
        modal.close();
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(this.data);
        if (!match) return;
        const rawYaml = match[1].trim();
        try {
          const schema = parseSchema(rawYaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.notes) sections.notes = [];
          sections.notes = sections.notes.filter((n: Record<string, string | number | boolean>) => n.note || n.task);
          sections.notes.push({ task: taskVal, note: noteVal });
          sections.notes.push({ task: '', note: '' });
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          this.data = this.data.replace(searchStr, replaceStr);
          this.suppressRender = true;
          this.requestSave();
          this.renderPlanner();
        } catch { /* skip */ }
      }));
    modal.open();
  }

  /** Add a mood entry to the current planner file */
  private addMoodModalFile() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить самочувствие' : 'Add mood');
    const contentEl = modal.contentEl;
    let metricVal = '';
    let valueVal = '';

    new Setting(contentEl)
      .setName(isRu ? 'Показатель' : 'Metric')
      .addText(txt => { txt.setPlaceholder(isRu ? '😊 Настроение' : '😊 Mood'); txt.onChange(v => metricVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Оценка (1–10)' : 'Rating (1–10)')
      .addText(txt => { txt.setPlaceholder('1–10'); txt.onChange(v => valueVal = v); });

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!metricVal.trim() || !valueVal.trim()) return;
        modal.close();
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(this.data);
        if (!match) return;
        const rawYaml = match[1].trim();
        try {
          const schema = parseSchema(rawYaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.mood) sections.mood = [];
          sections.mood = sections.mood.filter((m: Record<string, string | number | boolean>) => m.metric || m.value);
          sections.mood.push({ metric: metricVal, value: Number(valueVal) || 0 });
          sections.mood.push({ metric: '', value: '' });
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          this.data = this.data.replace(searchStr, replaceStr);
          this.suppressRender = true;
          this.requestSave();
          this.renderPlanner();
        } catch { /* skip */ }
      }));
    modal.open();
  }

  /** Add an exercise entry to the current planner file */
  private addExerciseModalFile() {
    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const modal = new Modal(this.app);
    modal.titleEl.setText(isRu ? 'Добавить тренировку' : 'Add exercise');
    const contentEl = modal.contentEl;
    let exerciseVal = '';
    let valueVal = '';
    let unitVal = '';

    new Setting(contentEl)
      .setName(isRu ? 'Упражнение' : 'Exercise')
      .addText(txt => { txt.setPlaceholder(isRu ? 'Отжимания' : 'Push-ups'); txt.onChange(v => exerciseVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Значение' : 'Value')
      .addText(txt => { txt.setPlaceholder('30'); txt.onChange(v => valueVal = v); });
    new Setting(contentEl)
      .setName(isRu ? 'Единица' : 'Unit')
      .addText(txt => { txt.setPlaceholder(isRu ? 'раз' : 'reps'); txt.onChange(v => unitVal = v); });

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText(isRu ? 'Добавить' : 'Add').setCta().onClick(async () => {
        if (!exerciseVal.trim()) return;
        modal.close();
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(this.data);
        if (!match) return;
        const rawYaml = match[1].trim();
        try {
          const schema = parseSchema(rawYaml);
          if (!schema.sections) (schema as PlannerSchema).sections = {};
          const sections = (schema as PlannerSchema).sections;
          if (!sections.exercise) sections.exercise = [];
          sections.exercise = sections.exercise.filter((e: Record<string, string | number | boolean>) => e.exercise || e.value);
          sections.exercise.push({ exercise: exerciseVal, value: Number(valueVal) || 0, unit: unitVal });
          sections.exercise.push({ exercise: '', value: '', unit: '' });
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          this.data = this.data.replace(searchStr, replaceStr);
          this.suppressRender = true;
          this.requestSave();
          this.renderPlanner();
        } catch { /* skip */ }
      }));
    modal.open();
  }

  /** Sync habits and weekly tasks across daily planners in the same week */
  private async syncWeeklyData(changedDay: string, changedYaml: string) {
    const date = new Date(changedDay);
    const week = getISOWeek(date);
    const year = date.getFullYear();
    const weekDays = getDaysInWeek(year, week);

    // Extract habits, weekly tasks, and daily tasks from the changed planner
    let changedHabits: { habit: string; description: string }[] = [];
    let changedWeeklyTasks: { task: string; priority: string; done: boolean; completedDate: string }[] = [];
    let changedDailyTasks: { task: string; priority: string; category: string }[] = [];
    try {
      const schema = parseSchema(changedYaml);
      const expanded = schema.template ? expandTemplate(schema) : schema;
      const sections = (expanded as PlannerSchema).sections;
      if (sections?.habits) {
        changedHabits = (sections.habits as Record<string, string | number | boolean>[])
          .filter((h: Record<string, string | number | boolean>) => h.habit)
          .map((h: Record<string, string | number | boolean>) => ({ habit: h.habit, description: h.description || '' }));
      }
      if (sections?.weeklyTasks) {
        changedWeeklyTasks = (sections.weeklyTasks as Record<string, string | number | boolean>[])
          .filter((t: Record<string, string | number | boolean>) => t.task)
          .map((t: Record<string, string | number | boolean>) => ({ task: t.task, priority: t.priority || '', category: t.category || '' }));
      }
      if (sections?.tasks) {
        changedDailyTasks = (sections.tasks as Record<string, string | number | boolean>[])
          .filter((t: Record<string, string | number | boolean>) => t.task)
          .map((t: Record<string, string | number | boolean>) => ({ task: t.task, priority: t.priority || '', category: t.category || '' }));
      }
    } catch { return; }

    if (changedHabits.length === 0 && changedWeeklyTasks.length === 0 && changedDailyTasks.length === 0) return;

    const filePath = this.file?.path || '';
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const dailyDir = parentDir.substring(0, parentDir.lastIndexOf('/'));

    for (const d of weekDays) {
      if (d.date === changedDay) continue;
      const [dy, dm] = d.date.split('-');
      const monthName = getMonthNames()[parseInt(dm) - 1];
      const targetPath = `${dailyDir}/${monthName} ${dy}/${d.date}.planner`;
      const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!targetFile || !(targetFile instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(targetFile);
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(content);
        if (!match) continue;

        const yamlStr = match[1].trim();
        const schema = parseSchema(yamlStr);
        if (schema.template !== 'daily-planner') continue;

        if (!schema.sections) (schema as PlannerSchema).sections = {};
        const sections = (schema as PlannerSchema).sections;
        let updated = false;

        // Sync habits
        if (changedHabits.length > 0) {
          if (!sections.habits) sections.habits = [];
          const existingNames = new Set((sections.habits as Record<string, string | number | boolean>[]).map((h: Record<string, string | number | boolean>) => h.habit).filter(Boolean));
          for (const ch of changedHabits) {
            if (!existingNames.has(ch.habit)) {
              sections.habits = sections.habits.filter((h: Record<string, string | number | boolean>) => h.habit);
              sections.habits.push({ habit: ch.habit, description: ch.description, done: false });
              updated = true;
            }
          }
          if (updated) sections.habits.push({ habit: '', description: '', done: false });
        }

        // Sync weekly tasks
        if (changedWeeklyTasks.length > 0) {
          if (!sections.weeklyTasks) sections.weeklyTasks = [];
          const existingTasks = new Map<string, Record<string, string | number | boolean>>();
          for (const t of sections.weeklyTasks as Record<string, string | number | boolean>[]) {
            if (t.task) existingTasks.set(t.task, t);
          }
          for (const ct of changedWeeklyTasks) {
            const existing = existingTasks.get(ct.task);
            if (!existing) {
              sections.weeklyTasks = sections.weeklyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
              sections.weeklyTasks.push({ done: false, task: ct.task, priority: ct.priority, category: ct.category, completedDate: '' });
              updated = true;
            }
          }
          if (updated) {
            sections.weeklyTasks = sections.weeklyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.weeklyTasks.push({ done: false, task: '', priority: '', category: '', completedDate: '' });
          }
        }

        // Sync daily tasks
        if (changedDailyTasks.length > 0) {
          if (!sections.tasks) sections.tasks = [];
          const existingNames = new Set((sections.tasks as Record<string, string | number | boolean>[]).map((t: Record<string, string | number | boolean>) => t.task).filter(Boolean));
          for (const ct of changedDailyTasks) {
            if (!existingNames.has(ct.task)) {
              sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
              sections.tasks.push({ done: false, task: ct.task, priority: ct.priority, category: ct.category });
              updated = true;
            }
          }
          if (updated) {
            sections.tasks = sections.tasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.tasks.push({ done: false, task: '', priority: '', category: '' });
          }
        }

        if (updated) {
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(targetFile, newContent);
          }
        }
      } catch { /* skip */ }
    }
  }

  /** Sync monthly tasks across all daily planners in the same month */
  private async syncMonthlyData(changedDay: string, changedYaml: string) {
    const monthStr = changedDay.substring(0, 7);
    const [yearStr, monthNumStr] = monthStr.split('-');
    const year = parseInt(yearStr);
    const monthNum = parseInt(monthNumStr);
    const daysInMonth = new Date(year, monthNum, 0).getDate();

    let changedMonthlyTasks: { task: string; priority: string; category: string }[] = [];
    try {
      const schema = parseSchema(changedYaml);
      const expanded = schema.template ? expandTemplate(schema) : schema;
      const sections = (expanded as PlannerSchema).sections;
      if (sections?.monthlyTasks) {
        changedMonthlyTasks = (sections.monthlyTasks as Record<string, string | number | boolean>[])
          .filter((t: Record<string, string | number | boolean>) => t.task)
          .map((t: Record<string, string | number | boolean>) => ({ task: t.task, priority: t.priority || '', category: t.category || '' }));
      }
    } catch { return; }
    if (changedMonthlyTasks.length === 0) return;

    const filePath = this.file?.path || '';
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const dailyDir = parentDir.substring(0, parentDir.lastIndexOf('/'));
    const monthName = getMonthNames()[monthNum - 1];
    const monthDir = `${dailyDir}/${monthName} ${yearStr}`;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${yearStr}-${monthNumStr}-${String(d).padStart(2, '0')}`;
      if (dateStr === changedDay) continue;
      const targetPath = `${monthDir}/${dateStr}.planner`;
      const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!targetFile || !(targetFile instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(targetFile);
        const regex = /```planner\n([\s\S]*?)```/;
        const match = regex.exec(content);
        if (!match) continue;
        const yamlStr = match[1].trim();
        const schema = parseSchema(yamlStr);
        if (schema.template !== 'daily-planner') continue;
        if (!schema.sections) (schema as PlannerSchema).sections = {};
        const sections = (schema as PlannerSchema).sections;
        let updated = false;
        if (!sections.monthlyTasks) sections.monthlyTasks = [];
        const existing = new Set((sections.monthlyTasks as Record<string, string | number | boolean>[]).map((t: Record<string, string | number | boolean>) => t.task).filter(Boolean));
        for (const ct of changedMonthlyTasks) {
          if (!existing.has(ct.task)) {
            sections.monthlyTasks = sections.monthlyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
            sections.monthlyTasks.push({ done: false, task: ct.task, priority: ct.priority, category: ct.category, completedDate: '' });
            updated = true;
          }
        }
        if (updated) {
          sections.monthlyTasks = sections.monthlyTasks.filter((t: Record<string, string | number | boolean>) => t.task);
          sections.monthlyTasks.push({ done: false, task: '', priority: '', category: '', completedDate: '' });
          const newYaml = serializeSchema(schema);
          const searchStr = '```planner\n' + match[1] + '```';
          const replaceStr = '```planner\n' + newYaml + '\n```';
          const newContent = content.replace(searchStr, replaceStr);
          if (newContent !== content) {
            await this.app.vault.modify(targetFile, newContent);
          }
        }
      } catch { /* skip */ }
    }
  }

  async onClose() {
    this.contentArea?.empty();
  }
}
