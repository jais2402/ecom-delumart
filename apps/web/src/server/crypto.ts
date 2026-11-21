import "./server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { fingerprint, generateCardNumber, normalizeEmail, normalizePhone } from "@delulu/core";
import { SERVER_CONFIG } from "./config";
import { env } from "./env";

/**
 * Server-side cryptography (LLD §5.4–5.6). Every `…With` function takes its key as a parameter
 * (pure, tested with known vectors); the short names read the key from the environment.
 */

export type RandomSource = (bytes: number) => Buffer;
const defaultRandom: RandomSource = (n) => randomBytes(n);

// ------------------------------------------------------------------ fingerprints (US-49)

export function emailFingerprintWith(identityKey: Uint8Array, email: string): Buffer {
  return Buffer.from(fingerprint(identityKey, normalizeEmail(email)), "hex");
}

/** Throws PHONE_INVALID for a number outside the allow-list. */
export function phoneFingerprintWith(identityKey: Uint8Array, phone: string): Buffer {
  return Buffer.from(fingerprint(identityKey, normalizePhone(phone)), "hex");
}

export const emailFingerprint = (email: string): Buffer => emailFingerprintWith(env().identityKey, email);
export const phoneFingerprint = (phone: string): Buffer => phoneFingerprintWith(env().identityKey, phone);

// ------------------------------------------------------------------ derived keys

/** A purpose-bound key derived from IDENTITY_KEY (HMAC-SHA-256 with a fixed label). */
export function derivedKeyWith(identityKey: Uint8Array, purpose: "rate-limit" | "csrf"): Buffer {
  return createHmac("sha256", identityKey).update(`delulumart/${purpose}/v1`, "utf8").digest();
}

/** The 32-byte subject of a database rate counter: no raw address or user id is stored. */
export function rateSubjectWith(identityKey: Uint8Array, kind: "address" | "actor", value: string): Buffer {
  return createHmac("sha256", derivedKeyWith(identityKey, "rate-limit"))
    .update(`${kind}\0${value}`, "utf8")
    .digest();
}

/** The CSRF token of a sign-in session: HMAC(server key, session id), 43 base64url characters. */
export function sessionCsrfTokenWith(identityKey: Uint8Array, sessionId: string): string {
  return createHmac("sha256", derivedKeyWith(identityKey, "csrf"))
    .update(sessionId.toLowerCase(), "utf8")
    .digest("base64url");
}

export const rateSubject = (kind: "address" | "actor", value: string): Buffer =>
  rateSubjectWith(env().identityKey, kind, value);
export const sessionCsrfToken = (sessionId: string): string =>
  sessionCsrfTokenWith(env().identityKey, sessionId);

// ------------------------------------------------------------------ PIN MAC (LLD §5.5)

/** HMAC-SHA-256(PIN_PEPPER, pin). The database only ever sees this, never the PIN. */
export function pinMacWith(pepper: Uint8Array, pin: string): Buffer {
  return createHmac("sha256", pepper).update(pin, "utf8").digest();
}

export const pinMac = (pin: string): Buffer => pinMacWith(env().pinPepper, pin);

// ------------------------------------------------------------------ field encryption (LLD §5.6)

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a ciphertext is bound to (associated data `table:userId`). */
export interface FieldBinding {
  table: string;
  userId: string;
}

function aadOf(binding: FieldBinding): Buffer {
  return Buffer.from(`${binding.table}:${binding.userId}`, "utf8");
}

/** AES-256-GCM; output keyId (1 byte) ‖ nonce (12) ‖ ciphertext ‖ tag (16). */
export function sealWith(input: {
  key: Uint8Array;
  keyId: number;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  aad: Uint8Array;
}): Buffer {
  if (input.key.length !== 32) throw new Error("field key must be 32 bytes");
  if (input.nonce.length !== NONCE_BYTES) throw new Error("nonce must be 12 bytes");
  if (!Number.isInteger(input.keyId) || input.keyId < 0 || input.keyId > 255) throw new Error("bad key id");
  const cipher = createCipheriv("aes-256-gcm", input.key, input.nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(input.aad);
  const body = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([input.keyId]), input.nonce, body, cipher.getAuthTag()]);
}

export function encryptFieldWith(
  key: Uint8Array,
  plaintext: string,
  binding: FieldBinding,
  random: RandomSource = defaultRandom,
  keyId: number = SERVER_CONFIG.fieldEncryption.currentKeyId,
): Buffer {
  return sealWith({
    key,
    keyId,
    nonce: random(NONCE_BYTES),
    plaintext: Buffer.from(plaintext, "utf8"),
    aad: aadOf(binding),
  });
}

/** Throws when the key id is unknown, the ciphertext was altered or it belongs to another binding. */
export function decryptFieldWith(key: Uint8Array, sealed: Uint8Array, binding: FieldBinding): string {
  const data = Buffer.from(sealed);
  if (data.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  if (data[0] !== SERVER_CONFIG.fieldEncryption.currentKeyId) throw new Error("unknown field key id");
  const nonce = data.subarray(1, 1 + NONCE_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(1 + NONCE_BYTES, data.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadOf(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export const encryptField = (plaintext: string, binding: FieldBinding): Buffer =>
  encryptFieldWith(env().fieldKey, plaintext, binding);
export const decryptField = (sealed: Uint8Array, binding: FieldBinding): string =>
  decryptFieldWith(env().fieldKey, sealed, binding);

/** The binding of the encrypted birthdate in private.user_secret. */
export const birthdateBinding = (userId: string): FieldBinding => ({ table: "user_secret", userId });

// ------------------------------------------------------------------ card numbers (LLD §5.4)

/** Candidates for sequences 1..5 (configuration), prefix 042000: provisioning stores the first free one. */
export function cardNumberCandidatesWith(cardKey: Uint8Array, userId: string, birthdate: string): string[] {
  const { prefix, firstSequence, candidates } = SERVER_CONFIG.card;
  return Array.from({ length: candidates }, (_, i) =>
    generateCardNumber({ cardKey, userId, birthdate, sequence: firstSequence + i, prefix }),
  );
}

export const cardNumberCandidates = (userId: string, birthdate: string): string[] =>
  cardNumberCandidatesWith(env().cardKey, userId, birthdate);

// ------------------------------------------------------------------ bank alias, DeluluPay id

/** Uniform letters by rejection sampling: no modulo bias. */
function randomLetters(alphabet: string, length: number, random: RandomSource): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet.charAt(byte % alphabet.length);
    }
  }
  return out;
}

const ALIAS_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O: never mistaken for digits
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A non-numeric bank alias such as DM-ACCT-QXRTMBNA (never looks like an account number). */
export function bankAlias(random: RandomSource = defaultRandom): string {
  return `DM-ACCT-${randomLetters(ALIAS_LETTERS, 8, random)}`;
}

/** `<handle>@delulu`, or `dm-<10 random letters>@delulu` before a handle is chosen. */
export function delulupayId(handle: string | null, random: RandomSource = defaultRandom): string {
  return `${handle ?? `dm-${randomLetters(ID_LETTERS, 10, random)}`}@delulu`;
}
