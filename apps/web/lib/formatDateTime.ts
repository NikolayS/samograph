export type DateTimeFormatOptions = {
  locale?: string;
  timeZone?: string;
};

export function formatDateTime(value: string, { locale, timeZone }: DateTimeFormatOptions = {}): string {
  return new Date(value).toLocaleString(locale, { timeZone });
}
