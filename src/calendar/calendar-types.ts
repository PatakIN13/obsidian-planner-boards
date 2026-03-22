/**
 * Simplified calendar types — ICS URL-based (like obsidian-day-planner).
 * Users just paste ICS links from Google Calendar, iCloud, Outlook, etc.
 */

export interface CalendarSource {
  id: string;
  name: string;
  url: string;        // ICS/iCal feed URL
  color: string;      // HEX color for events
  enabled: boolean;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  status?: string;
  sourceId: string;    // CalendarSource.id
  color: string;       // inherited from source
}

export interface CalendarCache {
  sources: Record<string, {
    events: SerializedEvent[];
    lastFetched: number;
  }>;
}

/** Serializable version of CalendarEvent for cache storage */
export interface SerializedEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;     // ISO 8601
  end: string;
  allDay: boolean;
  location?: string;
  status?: string;
  sourceId: string;
  color: string;
}

export interface CalendarSettings {
  sources: CalendarSource[];
  refreshIntervalMinutes: number;
  cache: CalendarCache;
}

export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  sources: [],
  refreshIntervalMinutes: 30,
  cache: { sources: {} },
};

/** Predefined color palette for quick selection */
export const CALENDAR_COLORS = [
  '#4285f4', // Google Blue
  '#ea4335', // Google Red
  '#fbbc04', // Google Yellow
  '#34a853', // Google Green
  '#ff6d01', // Orange
  '#46bdc6', // Teal
  '#7986cb', // Lavender
  '#e67c73', // Flamingo
  '#f4511e', // Tomato
  '#0b8043', // Basil
  '#8e24aa', // Grape
  '#616161', // Graphite
];
