import type { DashboardFormat } from '@retainer/shared';

type DashboardMoney = { amount: number; currency: string };

export const isMoney = (value: unknown): value is DashboardMoney =>
  value !== null &&
  typeof value === 'object' &&
  'amount' in value &&
  typeof value.amount === 'number' &&
  'currency' in value &&
  typeof value.currency === 'string';

export const isMixed = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  'mixedCurrencies' in value &&
  value.mixedCurrencies === true;

export function formatValue(value: unknown, format?: DashboardFormat): string {
  if (value === null || value === undefined) return '—';
  if (isMixed(value)) return 'Mixed currencies';
  if (isMoney(value)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: value.currency,
      }).format(value.amount);
    } catch {
      return `${value.amount.toLocaleString()} ${value.currency}`;
    }
  }
  if (typeof value === 'number') {
    if (format === 'percent')
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value / 100);
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof value === 'string' && format === 'date') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()))
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}),
      }).format(date);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
