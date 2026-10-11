/** Canonical transcript timestamp: `YYYY-MM-DD HH:MM:SS` in UTC. */
export function canonicalTs(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}
