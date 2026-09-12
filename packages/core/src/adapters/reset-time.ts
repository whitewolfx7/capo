/**
 * Turning a platform's human-readable reset time into a real timestamp.
 *
 * Why this exists: `AdapterEvent`'s `resetAt` is contractually an ISO
 * timestamp, and the orchestrator decides whether a platform is still capped
 * by comparing it to now. A human string like "3pm (UTC)" parses to an
 * Invalid Date, every comparison against it is false, and CAPO would conclude
 * a capped platform is available, switch back to it, get limited again, and
 * flap between platforms. So a value here is either a genuine ISO timestamp
 * or absent. Never a string that merely looks like a time.
 *
 * Absent is the safe direction: the orchestrator treats a limit with no reset
 * time as capped until something says otherwise, so it waits rather than
 * thrashing. The original wording is always preserved in the event's `raw`.
 */

/** Matches the fragment after "reset at", which is where the time lives. */
const AFTER_RESET_AT = /reset(?:s)?\s+at\s+(.+?)\s*$/i;

/** ISO 8601, when a platform is kind enough to emit one. */
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

/** A clock time: 3pm, 3:30pm, 15:00, optionally followed by a UTC marker. */
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b[\s.]*(?:\(?\s*(UTC|GMT)\s*\)?)?/i;

/**
 * Extracts a reset time from a usage-limit message.
 *
 * @param text the platform's raw message
 * @param now  reference point, injectable so tests are not clock-dependent
 * @returns an ISO 8601 string, or undefined when nothing parses confidently
 */
export function parseResetAt(text: string, now: Date = new Date()): string | undefined {
  const direct = ISO.exec(text);
  if (direct) {
    const d = new Date(direct[0]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const fragment = AFTER_RESET_AT.exec(text)?.[1];
  if (fragment === undefined) return undefined;

  const m = CLOCK.exec(fragment);
  if (!m) return undefined;

  const rawHour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  const utc = m[4] !== undefined;

  if (!Number.isInteger(rawHour) || minute > 59) return undefined;

  let hour = rawHour;
  if (meridiem === 'pm') {
    if (rawHour < 1 || rawHour > 12) return undefined;
    hour = rawHour === 12 ? 12 : rawHour + 12;
  } else if (meridiem === 'am') {
    if (rawHour < 1 || rawHour > 12) return undefined;
    hour = rawHour === 12 ? 0 : rawHour;
  } else if (rawHour > 23) {
    return undefined;
  }

  // The platform says a time of day, not a date. Resolve it to the next time
  // that clock reading occurs: later today, or tomorrow if it has passed.
  const candidate = utc
    ? new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0))
    : new Date(
        now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setTime(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate.toISOString();
}
