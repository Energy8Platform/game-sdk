/**
 * Currency metadata for Stake-supported currencies.
 *
 * The bridge looks up `CURRENCY_META[code]` once at Authenticate time
 * and surfaces the result via `INIT.config.currency`. Games can either
 * read the data directly to drive their own formatting, or call
 * `formatAmount(value, meta)` exported from this module.
 *
 * The list mirrors the table in the public ts-client `helpers.ts` so
 * approval reviewers can diff one-to-one.
 */

import type { CurrencyMetaData } from '@energy8platform/game-sdk/protocol';

export const CURRENCY_META: Record<string, CurrencyMetaData> = {
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  CAD: { code: 'CAD', symbol: 'CA$', decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
  RUB: { code: 'RUB', symbol: '₽', decimals: 2 },
  CNY: { code: 'CNY', symbol: 'CN¥', decimals: 2 },
  PHP: { code: 'PHP', symbol: '₱', decimals: 2 },
  INR: { code: 'INR', symbol: '₹', decimals: 2 },
  IDR: { code: 'IDR', symbol: 'Rp', decimals: 0 },
  KRW: { code: 'KRW', symbol: '₩', decimals: 0 },
  BRL: { code: 'BRL', symbol: 'R$', decimals: 2 },
  MXN: { code: 'MXN', symbol: 'MX$', decimals: 2 },
  DKK: { code: 'DKK', symbol: 'KR', decimals: 2, symbolAfter: true },
  PLN: { code: 'PLN', symbol: 'zł', decimals: 2, symbolAfter: true },
  VND: { code: 'VND', symbol: '₫', decimals: 0, symbolAfter: true },
  TRY: { code: 'TRY', symbol: '₺', decimals: 2 },
  CLP: { code: 'CLP', symbol: 'CLP', decimals: 0, symbolAfter: true },
  ARS: { code: 'ARS', symbol: 'ARS', decimals: 2, symbolAfter: true },
  PEN: { code: 'PEN', symbol: 'S/', decimals: 2 },
  NGN: { code: 'NGN', symbol: '₦', decimals: 2 },
  SAR: { code: 'SAR', symbol: 'SAR', decimals: 2, symbolAfter: true },
  ILS: { code: 'ILS', symbol: 'ILS', decimals: 2, symbolAfter: true },
  AED: { code: 'AED', symbol: 'AED', decimals: 2, symbolAfter: true },
  TWD: { code: 'TWD', symbol: 'NT$', decimals: 2 },
  NOK: { code: 'NOK', symbol: 'kr', decimals: 2 },
  KWD: { code: 'KWD', symbol: 'KD', decimals: 2 },
  JOD: { code: 'JOD', symbol: 'JD', decimals: 2 },
  CRC: { code: 'CRC', symbol: '₡', decimals: 2 },
  TND: { code: 'TND', symbol: 'TND', decimals: 2, symbolAfter: true },
  SGD: { code: 'SGD', symbol: 'SG$', decimals: 2 },
  MYR: { code: 'MYR', symbol: 'RM', decimals: 2 },
  OMR: { code: 'OMR', symbol: 'OMR', decimals: 2, symbolAfter: true },
  QAR: { code: 'QAR', symbol: 'QAR', decimals: 2, symbolAfter: true },
  BHD: { code: 'BHD', symbol: 'BD', decimals: 2 },
  XGC: { code: 'XGC', symbol: 'GC', decimals: 2, symbolAfter: true },
  XSC: { code: 'XSC', symbol: 'SC', decimals: 2, symbolAfter: true },
};

/**
 * Look up currency metadata. Returns a sensible fallback (the code
 * itself as the symbol, two decimals) for unknown currencies so the
 * bridge never throws on an exotic code.
 */
export function lookupCurrency(code: string): CurrencyMetaData {
  return (
    CURRENCY_META[code] ?? {
      code,
      symbol: code,
      decimals: 2,
      symbolAfter: true,
    }
  );
}

export interface FormatAmountOptions {
  /** Override the metadata's default decimals. */
  decimals?: number;
  /** Don't include the currency symbol. Default: include it. */
  removeSymbol?: boolean;
  /** Don't show the decimal part for whole numbers (`2.00 → 2`). */
  trimDecimalForIntegers?: boolean;
  /** Locale for `Intl.NumberFormat`. Default: `navigator.language`. */
  locale?: string;
}

/**
 * Format a decimal amount for display using the supplied currency
 * metadata. Mirrors Stake's `DisplayAmount` behaviour from ts-client.
 *
 * ```ts
 * formatAmount(1234.5, lookupCurrency('USD'))
 * // → '$1,234.50'
 * formatAmount(10, lookupCurrency('PLN'), { trimDecimalForIntegers: true })
 * // → '10 zł'
 * ```
 */
export function formatAmount(
  amount: number,
  meta: CurrencyMetaData,
  options: FormatAmountOptions = {},
): string {
  const locale =
    options.locale ??
    (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

  let decimals = options.decimals ?? meta.decimals;
  if (options.trimDecimalForIntegers && Number.isInteger(amount)) {
    decimals = 0;
  }

  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);

  if (options.removeSymbol) return formatted;
  return meta.symbolAfter
    ? `${formatted} ${meta.symbol}`
    : `${meta.symbol}${formatted}`;
}
