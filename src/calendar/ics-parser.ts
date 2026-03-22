import { CalendarEvent, SerializedEvent } from './calendar-types';

/**
 * Minimal ICS/iCal parser.
 * Extracts VEVENT components from iCalendar format (RFC 5545).
 */
export function parseICS(icsText: string, sourceId: string, color: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // Unfold long lines (RFC 5545 §3.1)
  const unfolded = icsText.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
  const lines = unfolded.split('\n');

  let inEvent = false;
  let current: Partial<CalendarEvent> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      current = { sourceId, color };
      continue;
    }

    if (trimmed === 'END:VEVENT') {
      inEvent = false;
      if (current.uid && current.start && current.end) {
        events.push(current as CalendarEvent);
      } else if (current.uid && current.start && !current.end) {
        // Single-point event: end = start
        current.end = current.start;
        events.push(current as CalendarEvent);
      }
      current = {};
      continue;
    }

    if (!inEvent) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const keyPart = trimmed.substring(0, colonIdx);
    const value = trimmed.substring(colonIdx + 1);
    const key = keyPart.split(';')[0]; // strip parameters like DTSTART;VALUE=DATE

    switch (key) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescapeICS(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeICS(value);
        break;
      case 'LOCATION':
        current.location = unescapeICS(value);
        break;
      case 'STATUS':
        current.status = value.toLowerCase();
        break;
      case 'DTSTART':
        current.start = parseICSDate(value);
        current.allDay = isDateOnly(keyPart, value);
        break;
      case 'DTEND':
        current.end = parseICSDate(value);
        break;
      case 'DURATION': {
        if (current.start) {
          current.end = addDuration(current.start, value);
        }
        break;
      }
    }
  }

  return events;
}

/**
 * Parse iCal date/datetime string to JS Date.
 * Supports: 20260315, 20260315T100000, 20260315T100000Z
 */
function parseICSDate(value: string): Date {
  const clean = value.replace(/[^0-9TZ]/g, '');

  if (clean.length === 8) {
    // Date only: YYYYMMDD
    const y = parseInt(clean.slice(0, 4));
    const m = parseInt(clean.slice(4, 6)) - 1;
    const d = parseInt(clean.slice(6, 8));
    return new Date(y, m, d);
  }

  // DateTime: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const y = parseInt(clean.slice(0, 4));
  const m = parseInt(clean.slice(4, 6)) - 1;
  const d = parseInt(clean.slice(6, 8));
  const hh = parseInt(clean.slice(9, 11));
  const mm = parseInt(clean.slice(11, 13));
  const ss = parseInt(clean.slice(13, 15)) || 0;

  if (clean.endsWith('Z')) {
    return new Date(Date.UTC(y, m, d, hh, mm, ss));
  }

  return new Date(y, m, d, hh, mm, ss);
}

function isDateOnly(keyPart: string, value: string): boolean {
  if (keyPart.includes('VALUE=DATE') && !keyPart.includes('VALUE=DATE-TIME')) {
    return true;
  }
  return value.replace(/[^0-9]/g, '').length === 8;
}

/**
 * Parse ISO 8601 duration and add to date. Handles P1D, PT1H30M, etc.
 */
function addDuration(start: Date, duration: string): Date {
  const result = new Date(start);
  const match = duration.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!match) return result;

  const [, weeks, days, hours, minutes, seconds] = match;
  if (weeks) result.setDate(result.getDate() + parseInt(weeks) * 7);
  if (days) result.setDate(result.getDate() + parseInt(days));
  if (hours) result.setHours(result.getHours() + parseInt(hours));
  if (minutes) result.setMinutes(result.getMinutes() + parseInt(minutes));
  if (seconds) result.setSeconds(result.getSeconds() + parseInt(seconds));

  return result;
}

function unescapeICS(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// --- Serialization helpers for cache ---

export function serializeEvent(ev: CalendarEvent): SerializedEvent {
  return {
    uid: ev.uid,
    summary: ev.summary,
    description: ev.description,
    start: ev.start.toISOString(),
    end: ev.end.toISOString(),
    allDay: ev.allDay,
    location: ev.location,
    status: ev.status,
    sourceId: ev.sourceId,
    color: ev.color,
  };
}

export function deserializeEvent(se: SerializedEvent): CalendarEvent {
  return {
    ...se,
    start: new Date(se.start),
    end: new Date(se.end),
  };
}
