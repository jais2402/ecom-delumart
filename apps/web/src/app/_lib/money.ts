/**
 * Money arrives from the API as a decimal string of integer paise. It is parsed with BigInt and
 * never passes through Number.
 */
export function parsePaise(value: string): bigint {
  if (!/^-?\d{1,19}$/.test(value)) throw new Error("Unexpected money value from the server.");
  return BigInt(value);
}

/** Like parsePaise but keeps null/undefined as null (a balance that is not known yet). */
export function parsePaiseOrNull(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : parsePaise(value);
}
