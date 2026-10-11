/** Encode strings as a Postgres array literal suitable for an explicit text[] cast. */
export function toPgTextArray(values: readonly string[]): string {
  const elements = values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`);
  return `{${elements.join(",")}}`;
}
