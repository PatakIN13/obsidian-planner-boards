import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type PlannerBoardsPlugin from './main';
import { CalendarSettings, DEFAULT_CALENDAR_SETTINGS, CALENDAR_COLORS, CalendarSource } from './calendar/calendar-types';
import { t, setLocale, Locale } from './i18n';

export interface PlannerBoardsSettings {
  defaultTheme: string;
  defaultLocale: string;
  uiLanguage: 'ru' | 'en';
  defaultCurrency: string;
  autoSaveDelay: number;
  firstDayOfWeek: number; // 0 = Sunday, 1 = Monday
  defaultCellWidth: number;
  templatesFolder: string;
  calendar: CalendarSettings;
}

export const DEFAULT_SETTINGS: PlannerBoardsSettings = {
  defaultTheme: 'soft',
  defaultLocale: 'ru',
  uiLanguage: 'ru',
  defaultCurrency: '₽',
  autoSaveDelay: 500,
  firstDayOfWeek: 1,
  defaultCellWidth: 80,
  templatesFolder: '_planner-templates',
  calendar: { ...DEFAULT_CALENDAR_SETTINGS },
};

export class PlannerBoardsSettingTab extends PluginSettingTab {
  plugin: PlannerBoardsPlugin;

  constructor(app: App, plugin: PlannerBoardsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: t('settings.title') });

    new Setting(containerEl)
      .setName(t('settings.theme'))
      .setDesc(t('settings.themeDesc'))
      .addDropdown(dd => dd
        .addOption('minimal', 'Minimal')
        .addOption('soft', 'Soft')
        .addOption('vibrant', 'Vibrant')
        .addOption('dark', 'Dark')
        .setValue(this.plugin.settings.defaultTheme)
        .onChange(async (val) => {
          this.plugin.settings.defaultTheme = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.locale'))
      .setDesc(t('settings.localeDesc'))
      .addDropdown(dd => dd
        .addOption('ru', 'Русский')
        .addOption('en', 'English')
        .setValue(this.plugin.settings.defaultLocale)
        .onChange(async (val) => {
          this.plugin.settings.defaultLocale = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.uiLanguage'))
      .setDesc(t('settings.uiLanguageDesc'))
      .addDropdown(dd => dd
        .addOption('ru', 'Русский')
        .addOption('en', 'English')
        .setValue(this.plugin.settings.uiLanguage)
        .onChange(async (val) => {
          this.plugin.settings.uiLanguage = val as Locale;
          setLocale(val as Locale);
          await this.plugin.saveSettings();
          this.display(); // re-render with new language
        }));

    new Setting(containerEl)
      .setName(t('settings.currency'))
      .setDesc(t('settings.currencyDesc'))
      .addText(text => text
        .setValue(this.plugin.settings.defaultCurrency)
        .onChange(async (val) => {
          this.plugin.settings.defaultCurrency = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.autoSaveDelay'))
      .setDesc(t('settings.autoSaveDelayDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.autoSaveDelay))
        .onChange(async (val) => {
          const num = parseInt(val);
          if (!isNaN(num) && num >= 0) {
            this.plugin.settings.autoSaveDelay = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName(t('settings.firstDayOfWeek'))
      .addDropdown(dd => dd
        .addOption('1', t('ui.monday'))
        .addOption('0', t('ui.sunday'))
        .setValue(String(this.plugin.settings.firstDayOfWeek))
        .onChange(async (val) => {
          this.plugin.settings.firstDayOfWeek = parseInt(val);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.templateFolder'))
      .setDesc(t('settings.templateFolderDesc'))
      .addText(text => text
        .setValue(this.plugin.settings.templatesFolder)
        .setPlaceholder('_planner-templates')
        .onChange(async (val) => {
          this.plugin.settings.templatesFolder = val || '_planner-templates';
          await this.plugin.saveSettings();
        }));

    // --- Calendar Integration ---
    containerEl.createEl('h2', { text: t('settings.calendarTitle') });
    containerEl.createEl('p', {
      text: t('settings.calendarDesc'),
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName(t('settings.syncInterval'))
      .setDesc(t('settings.syncIntervalDesc'))
      .addText(text => text
        .setValue(String(this.plugin.settings.calendar.refreshIntervalMinutes))
        .onChange(async (val) => {
          const num = parseInt(val);
          if (!isNaN(num) && num >= 1) {
            this.plugin.settings.calendar.refreshIntervalMinutes = num;
            await this.plugin.saveSettings();
            this.plugin.restartCalendarSync();
          }
        }));

    // Existing calendar sources
    const sources = this.plugin.settings.calendar.sources;
    for (const source of sources) {
      this.renderCalendarSource(containerEl, source);
    }

    // Add new calendar button
    new Setting(containerEl)
      .addButton(btn => btn
        .setButtonText(t('btn.addCalendar'))
        .setCta()
        .onClick(async () => {
          const sync = this.plugin.calendarSync;
          if (!sync) return;
          const id = sync.generateId();
          const colorIdx = sources.length % CALENDAR_COLORS.length;
          const newSource: CalendarSource = {
            id,
            name: t('ui.calendarN', { n: sources.length + 1 }),
            url: '',
            color: CALENDAR_COLORS[colorIdx],
            enabled: true,
          };
          this.plugin.settings.calendar.sources.push(newSource);
          await this.plugin.saveSettings();
          this.display(); // re-render
        }))
      .addButton(btn => btn
        .setButtonText(t('btn.syncAll'))
        .onClick(async () => {
          try {
            await this.plugin.syncCalendars();
            new Notice(t('notice.calendarsSynced'));
            this.display();
          } catch (e) {
            new Notice(t('notice.error', { msg: e instanceof Error ? e.message : String(e) }));
          }
        }));
  }

  private renderCalendarSource(containerEl: HTMLElement, source: CalendarSource) {
    const wrapper = containerEl.createDiv({ cls: 'planner-calendar-source' });
    wrapper.style.cssText = 'border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 12px; margin: 8px 0;';

    // Header with color dot + name + toggle
    const header = wrapper.createDiv();
    header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

    const colorDot = header.createEl('span');
    colorDot.style.cssText = `width: 14px; height: 14px; border-radius: 50%; display: inline-block; background: ${source.color}; flex-shrink: 0; cursor: pointer;`;
    colorDot.title = t('ui.clickForColor');
    colorDot.addEventListener('click', () => {
      this.showColorPicker(source, colorDot);
    });

    const nameEl = header.createEl('strong', { text: source.name });
    nameEl.style.flex = '1';

    // Cache age
    const sync = this.plugin.calendarSync;
    if (sync) {
      const age = sync.getCacheAge(source.id);
      const ageEl = header.createEl('span', { text: age });
      ageEl.style.cssText = 'font-size: 0.8em; color: var(--text-muted);';
    }

    // Name input
    new Setting(wrapper)
      .setName(t('settings.calName'))
      .addText(text => text
        .setValue(source.name)
        .setPlaceholder(t('settings.calNamePlaceholder'))
        .onChange(async (val) => {
          source.name = val;
          nameEl.textContent = val;
          await this.plugin.saveSettings();
        }));

    // ICS URL input
    new Setting(wrapper)
      .setName(t('settings.calUrl'))
      .setDesc(t('settings.calUrlDesc'))
      .addText(text => {
        text.inputEl.style.width = '100%';
        text.inputEl.style.fontFamily = 'monospace';
        text.inputEl.style.fontSize = '0.85em';
        text
          .setValue(source.url)
          .setPlaceholder(t('settings.calUrlPlaceholder'))
          .onChange(async (val) => {
            source.url = val;
            await this.plugin.saveSettings();
          });
      });

    // Actions row
    new Setting(wrapper)
      .addToggle(toggle => toggle
        .setValue(source.enabled)
        .setTooltip(source.enabled ? t('ui.enabled') : t('ui.disabled'))
        .onChange(async (val) => {
          source.enabled = val;
          await this.plugin.saveSettings();
        }))
      .addButton(btn => btn
        .setButtonText(t('btn.sync'))
        .onClick(async () => {
          if (!source.url) {
            new Notice(t('notice.enterIcsUrl'));
            return;
          }
          try {
            await this.plugin.syncCalendars();
            new Notice(t('notice.calendarSynced', { name: source.name }));
            this.display();
          } catch (e) {
            new Notice(t('notice.error', { msg: e instanceof Error ? e.message : String(e) }));
          }
        }))
      .addButton(btn => btn
        .setButtonText(t('btn.delete'))
        .setWarning()
        .onClick(async () => {
          if (sync) sync.removeSource(source.id);
          this.plugin.settings.calendar.sources = this.plugin.settings.calendar.sources.filter(s => s.id !== source.id);
          await this.plugin.saveSettings();
          this.display();
        }));
  }

  private showColorPicker(source: CalendarSource, anchor: HTMLElement) {
    // Remove existing picker
    const existing = document.querySelector('.planner-color-picker-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = 'planner-color-picker-popup';
    popup.style.cssText = `
      position: fixed; z-index: 1000; background: var(--background-primary);
      border: 1px solid var(--background-modifier-border); border-radius: 8px;
      padding: 8px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    `;

    const rect = anchor.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    for (const color of CALENDAR_COLORS) {
      const swatch = popup.createEl('div');
      swatch.style.cssText = `
        width: 28px; height: 28px; border-radius: 50%; background: ${color};
        cursor: pointer; border: 2px solid ${color === source.color ? 'var(--text-normal)' : 'transparent'};
        transition: border-color 0.15s;
      `;
      swatch.addEventListener('click', async () => {
        source.color = color;
        anchor.style.background = color;
        await this.plugin.saveSettings();
        popup.remove();
      });
    }

    // Custom color input
    const customRow = popup.createDiv();
    customRow.style.cssText = 'grid-column: 1 / -1; margin-top: 4px;';
    const input = customRow.createEl('input', { type: 'color' });
    input.value = source.color;
    input.style.cssText = 'width: 100%; height: 28px; border: none; padding: 0; cursor: pointer;';
    input.addEventListener('change', async () => {
      source.color = input.value;
      anchor.style.background = input.value;
      await this.plugin.saveSettings();
      popup.remove();
    });

    document.body.appendChild(popup);

    // Close on outside click
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) {
        popup.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}
