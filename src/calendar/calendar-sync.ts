import { Notice, requestUrl } from 'obsidian';
import {
  CalendarEvent,
  CalendarSettings,
  CalendarSource,
  DEFAULT_CALENDAR_SETTINGS,
} from './calendar-types';
import { parseICS, serializeEvent, deserializeEvent } from './ics-parser';
import { t } from '../i18n';

/**
 * Calendar sync engine — fetches ICS feeds, caches results, auto-refreshes.
 */
export class CalendarSyncEngine {
  private settings: CalendarSettings;
  private onSettingsChange: (settings: CalendarSettings) => Promise<void>;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private events: CalendarEvent[] = [];

  constructor(
    settings: CalendarSettings | undefined,
    onSettingsChange: (settings: CalendarSettings) => Promise<void>
  ) {
    this.settings = settings || { ...DEFAULT_CALENDAR_SETTINGS };
    this.onSettingsChange = onSettingsChange;
    // Load cached events
    this.loadFromCache();
  }

  getSettings(): CalendarSettings {
    return this.settings;
  }

  updateSettings(settings: CalendarSettings) {
    this.settings = settings;
  }

  getEvents(): CalendarEvent[] {
    return this.events;
  }

  /**
   * Fetch events from all enabled ICS sources.
   */
  async syncAll(): Promise<CalendarEvent[]> {
    const enabledSources = this.settings.sources.filter(s => s.enabled);
    if (enabledSources.length === 0) {
      return this.events;
    }

    const results: CalendarEvent[] = [];
    let hasError = false;

    for (const source of enabledSources) {
      try {
        const events = await this.fetchSource(source);
        results.push(...events);

        // Update cache per source
        this.settings.cache.sources[source.id] = {
          events: events.map(serializeEvent),
          lastFetched: Date.now(),
        };
      } catch (e) {
        hasError = true;
        console.warn(`Planner Boards: failed to fetch "${source.name}":`, e);

        // Use cached events for this source
        const cached = this.settings.cache.sources[source.id];
        if (cached) {
          results.push(...cached.events.map(deserializeEvent));
        }
      }
    }

    // Sort by start time
    results.sort((a, b) => a.start.getTime() - b.start.getTime());
    this.events = results;

    await this.onSettingsChange(this.settings);

    if (hasError) {
      new Notice(t('notice.calendarPartialFail'));
    }

    return results;
  }

  /**
   * Fetch & parse a single ICS source.
   */
  private async fetchSource(source: CalendarSource): Promise<CalendarEvent[]> {
    const resp = await requestUrl({ url: source.url });
    const icsText = resp.text;
    return parseICS(icsText, source.id, source.color);
  }

  /**
   * Get events within a time range.
   */
  getEventsInRange(start: Date, end: Date): CalendarEvent[] {
    return this.events.filter(ev =>
      ev.end > start && ev.start < end
    );
  }

  /**
   * Get events for a specific day.
   */
  getEventsForDay(date: Date): CalendarEvent[] {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);
    return this.getEventsInRange(dayStart, dayEnd);
  }

  // --- Source management ---

  addSource(source: CalendarSource) {
    this.settings.sources.push(source);
  }

  removeSource(id: string) {
    this.settings.sources = this.settings.sources.filter(s => s.id !== id);
    delete this.settings.cache.sources[id];
  }

  updateSource(id: string, updates: Partial<CalendarSource>) {
    const src = this.settings.sources.find(s => s.id === id);
    if (src) Object.assign(src, updates);
  }

  // --- Auto-sync timer ---

  startAutoSync(onSync: () => void) {
    this.stopAutoSync();
    const ms = this.settings.refreshIntervalMinutes * 60_000;
    if (ms > 0) {
      this.syncAll().catch(() => {}); // initial fetch
      this.timerId = setInterval(onSync, ms);
    }
  }

  stopAutoSync() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  // --- Cache helpers ---

  private loadFromCache() {
    const all: CalendarEvent[] = [];
    for (const [, cached] of Object.entries(this.settings.cache.sources)) {
      if (cached?.events) {
        all.push(...cached.events.map(deserializeEvent));
      }
    }
    all.sort((a, b) => a.start.getTime() - b.start.getTime());
    this.events = all;
  }

  getCacheAge(sourceId: string): string {
    const cached = this.settings.cache.sources[sourceId];
    if (!cached?.lastFetched) return t('ui.noData');
    const mins = Math.round((Date.now() - cached.lastFetched) / 60_000);
    if (mins < 1) return t('ui.justNow');
    if (mins < 60) return t('ui.minsAgo', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('ui.hoursAgo', { n: hours });
    return t('ui.daysAgo', { n: Math.round(hours / 24) });
  }

  generateId(): string {
    return 'cal_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
}
