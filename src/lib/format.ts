/**
 * Formatting helpers. The mockups' logic classes are the reference for every
 * string shape here, so the UI copy stays identical to the design.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** "35h 06m" — the shape used in shelf labels and book metadata. */
export function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

/**
 * "1.0 GB" above a gigabyte, "550 MB" below it. The threshold is 1000 MB rather
 * than 1024, matching the mockups: a 1011 MB book should read "1.0 GB", not
 * "1011 MB".
 */
export function bytes(value: number): string {
  if (Math.abs(value) >= 1000 * MB) return `${(value / GB).toFixed(1)} GB`;
  return `${Math.round(value / MB)} MB`;
}

/** Always gigabytes, for the budget ruler and tray summary. */
export function gigabytes(value: number): string {
  return `${(value / GB).toFixed(1)} GB`;
}

/** "12:05" — chapter scrubber position and remaining. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "3h 04m" — whole-book remaining time. */
export function hoursLeft(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** "204 days of listening" — the Library header's total. */
export function daysOfListening(totalSeconds: number): string {
  const days = Math.round(totalSeconds / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} of listening`;
}

/**
 * "around 9:41 pm", or "in 2d, around 9:41 pm" when the book will not finish
 * today at the current speed.
 */
export function finishTime(secondsOfRealTime: number, now = Date.now()): string {
  const end = new Date(now + secondsOfRealTime * 1000);
  const days = Math.floor(secondsOfRealTime / 86400);
  const suffix = end.getHours() >= 12 ? 'pm' : 'am';
  const hour = end.getHours() % 12 || 12;
  const minutes = String(end.getMinutes()).padStart(2, '0');
  return `${days > 0 ? `in ${days}d, ` : ''}around ${hour}:${minutes} ${suffix}`;
}

/** "MAR 03 2025" — the library card's stamped dates. */
export function stampDate(iso: string): string {
  const d = new Date(iso);
  const months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')} ${d.getFullYear()}`;
}

/** "3 min ago" — the compact form for the Library header. */
export function relativeTimeShort(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** "2 days ago" — the drive's "last seen" line. */
export function relativeTime(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

export { GB, MB };
