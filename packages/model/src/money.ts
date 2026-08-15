// Money is always integer minor units + currency, never a bare number. See CLAUDE.md.

export type CurrencyCode = string; // ISO 4217, e.g. "USD", "EUR"

const MONEY_BRAND = Symbol("Money");

export interface Money {
  readonly [MONEY_BRAND]: true;
  readonly minorUnits: number;
  readonly currency: CurrencyCode;
}

export function money(minorUnits: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError(`Money.minorUnits must be an integer, got ${minorUnits}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError(`Money.currency must be a 3-letter ISO 4217 code, got "${currency}"`);
  }
  return { [MONEY_BRAND]: true, minorUnits, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Cannot combine Money of different currencies (${a.currency} vs ${b.currency}) without an explicit conversion at read time — see CLAUDE.md currency rules.`
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minorUnits + b.minorUnits, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minorUnits - b.minorUnits, a.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce((acc, m) => add(acc, m), money(0, currency));
}

export function isZero(m: Money): boolean {
  return m.minorUnits === 0;
}

export function formatMinor(m: Money): string {
  // Presentation-only helper — assumes a 2-decimal currency; not for computation.
  return `${(m.minorUnits / 100).toFixed(2)} ${m.currency}`;
}
