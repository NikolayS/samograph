/**
 * Compact "when was this" copy for a list row (mobile audit M7). Pure and
 * clock-injected — `now` is a parameter, never `Date.now()` inside — so the
 * output is exactly assertable and the component stays deterministic.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `"just now"` / `"7 min ago"` / `"3 h ago"` / `"2 d ago"`, and past a week the
 * date itself (`"12 Aug"`, or `"31 Dec 2025"` in another year). Returns `""`
 * for a missing or unparseable timestamp so the caller can omit the element.
 */
export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  // Clock skew (a server timestamp slightly ahead of the browser) reads as "now",
  // never as a negative age.
  const age = Math.max(0, now - at);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)} d ago`;

  const date = new Date(at);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? day
    : `${day} ${date.getFullYear()}`;
}
