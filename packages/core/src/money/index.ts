/** Money is integer paise held in a bigint. Never use number arithmetic on money. */
export type Paise = bigint;

export const PAISE_PER_RUPEE = 100n;
export const LAKH_RUPEES = 100_000n;
export const CRORE_RUPEES = 10_000_000n;

export const STARTING_GRANT_PAISE: Paise = 100n * CRORE_RUPEES * PAISE_PER_RUPEE;
export const CREATOR_THRESHOLD_PAISE: Paise = 1n * CRORE_RUPEES * PAISE_PER_RUPEE;
export const MIN_PRICE_PAISE: Paise = 100n * PAISE_PER_RUPEE;
export const MAX_PRICE_PAISE: Paise = 100n * CRORE_RUPEES * PAISE_PER_RUPEE;

export function rupees(amount: bigint | number): Paise {
  return BigInt(amount) * PAISE_PER_RUPEE;
}

/** Parse the decimal-string form used in JSON. Rejects anything that is not a plain integer. */
export function parsePaise(value: string): Paise {
  if (!/^-?\d+$/.test(value)) throw new RangeError(`not an integer paise string: ${value}`);
  return BigInt(value);
}

export function serializePaise(value: Paise): string {
  return value.toString();
}

/** Group digits the Indian way: 1,00,00,000. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** Exact amount, e.g. ₹1,80,01,000 (paise shown only when non-zero). */
export function formatInrExact(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = abs % PAISE_PER_RUPEE;
  const body = groupIndian(whole.toString()) + (fraction === 0n ? "" : `.${fraction.toString().padStart(2, "0")}`);
  return `${negative ? "−" : ""}₹${body}`;
}

function scaled(wholeRupees: bigint, unit: bigint): string {
  // two decimal places, truncated (never rounds a balance up), trailing zeros removed
  const hundredths = (wholeRupees * 100n) / unit;
  const int = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

/** Compact display, e.g. ₹90 lakh, ₹1.8 crore. Truncates; use formatInrExact where precision matters. */
export function formatInrCompact(paise: Paise): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  let body: string;
  if (whole >= CRORE_RUPEES) body = `₹${scaled(whole, CRORE_RUPEES)} crore`;
  else if (whole >= LAKH_RUPEES) body = `₹${scaled(whole, LAKH_RUPEES)} lakh`;
  else body = formatInrExact(abs);
  return `${negative ? "−" : ""}${body}`;
}

/** Screen-reader label, e.g. "1.8 crore fictional rupees". */
export function inrAccessibleLabel(paise: Paise): string {
  const compact = formatInrCompact(paise).replace("₹", "").replace("−", "minus ");
  return `${compact} fictional rupees`;
}
