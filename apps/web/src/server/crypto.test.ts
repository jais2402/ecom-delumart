import { createHmac, randomBytes } from "node:crypto";
import { generateCardNumber, luhnValid } from "@delulu/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bankAlias,
  cardNumberCandidatesWith,
  decryptFieldWith,
  delulupayId,
  emailFingerprintWith,
  encryptFieldWith,
  phoneFingerprintWith,
  pinMacWith,
  sealWith,
} from "./crypto";

const hex = (s: string) => Buffer.from(s, "hex");

describe("pinMac = HMAC-SHA-256(PIN_PEPPER, pin) (LLD §5.5)", () => {
  it("US-48: matches RFC 4231 test cases 1 and 2", () => {
    expect(pinMacWith(Buffer.alloc(20, 0x0b), "Hi There").toString("hex")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
    expect(pinMacWith(Buffer.from("Jefe"), "what do ya want for nothing?").toString("hex")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("US-48: is 32 bytes and differs per pepper", () => {
    const a = pinMacWith(randomBytes(32), "482913");
    const b = pinMacWith(randomBytes(32), "482913");
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("identity fingerprints (LLD §5.6, US-49)", () => {
  const key = hex("4a656665".repeat(8));

  it("US-49: email fingerprint is HMAC-SHA-256(IDENTITY_KEY, normalised email)", () => {
    const expected = createHmac("sha256", key).update("playerone@gmail.com").digest();
    expect(emailFingerprintWith(key, "  Player.One+shop@GoogleMail.com ").equals(expected)).toBe(true);
    expect(emailFingerprintWith(key, "playerone@gmail.com").equals(expected)).toBe(true);
  });

  it("US-49: phone fingerprint is HMAC-SHA-256(IDENTITY_KEY, E.164)", () => {
    const expected = createHmac("sha256", key).update("+919876543210").digest();
    expect(phoneFingerprintWith(key, "+91 98765-43210").equals(expected)).toBe(true);
  });

  it("US-49: an invalid phone is PHONE_INVALID", () => {
    expect(() => phoneFingerprintWith(key, "98765 43210")).toThrow(
      expect.objectContaining({ code: "PHONE_INVALID" }),
    );
  });
});

describe("field encryption: AES-256-GCM, keyId‖nonce‖ciphertext‖tag (LLD §5.6)", () => {
  it("matches the GCM spec test case 14 (AES-256, zero key, zero IV, empty AAD)", () => {
    const sealed = sealWith({
      key: Buffer.alloc(32),
      keyId: 1,
      nonce: Buffer.alloc(12),
      plaintext: Buffer.alloc(16),
      aad: Buffer.alloc(0),
    });
    expect(sealed.toString("hex")).toBe(
      `01${"00".repeat(12)}cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919`,
    );
  });

  it("matches the GCM spec test case 16 (AES-256 with associated data)", () => {
    const sealed = sealWith({
      key: hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"),
      keyId: 1,
      nonce: hex("cafebabefacedbaddecaf888"),
      plaintext: hex(
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
      ),
      aad: hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"),
    });
    expect(sealed.subarray(13).toString("hex")).toBe(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" +
        "76fc6ece0f4e1768cddf8853bb2d551b",
    );
  });

  it("US-49: round-trips for the same user and uses a fresh nonce every time", () => {
    const key = randomBytes(32);
    const binding = { table: "user_secret", userId: "0192f6a0-0000-7000-8000-000000000001" };
    const a = encryptFieldWith(key, "1990-04-12", binding);
    const b = encryptFieldWith(key, "1990-04-12", binding);
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a.length).toBe(1 + 12 + 10 + 16);
    expect(decryptFieldWith(key, a, binding)).toBe("1990-04-12");
  });

  it("US-49: a ciphertext copied to another user (or table, or tampered) does not decrypt", () => {
    const key = randomBytes(32);
    const binding = { table: "user_secret", userId: "0192f6a0-0000-7000-8000-000000000001" };
    const sealed = encryptFieldWith(key, "1990-04-12", binding);
    expect(() =>
      decryptFieldWith(key, sealed, { ...binding, userId: "0192f6a0-0000-7000-8000-000000000002" }),
    ).toThrow();
    expect(() => decryptFieldWith(key, sealed, { ...binding, table: "address" })).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => decryptFieldWith(key, tampered, binding)).toThrow();
    expect(() => decryptFieldWith(randomBytes(32), sealed, binding)).toThrow();
  });

  it("round-trips any text (property)", () => {
    const key = randomBytes(32);
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.uuid(), (text, userId) => {
        const binding = { table: "t", userId };
        return decryptFieldWith(key, encryptFieldWith(key, text, binding), binding) === text;
      }),
    );
  });
});

describe("card number candidates (LLD §5.4, US-15)", () => {
  const cardKey = randomBytes(32);
  const userId = "0192f6a0-0000-7000-8000-00000000000a";

  it("US-15: five candidates for sequences 1..5 with prefix 042000, from core's algorithm", () => {
    const candidates = cardNumberCandidatesWith(cardKey, userId, "1990-04-12");
    expect(candidates).toHaveLength(5);
    expect(candidates).toEqual(
      [1, 2, 3, 4, 5].map((sequence) =>
        generateCardNumber({ cardKey, userId, birthdate: "1990-04-12", sequence, prefix: "042000" }),
      ),
    );
    for (const n of candidates) {
      expect(n).toMatch(/^042000\d{10}$/);
      expect(luhnValid(n)).toBe(false);
    }
    expect(new Set(candidates).size).toBe(5);
  });
});

describe("bank alias and DeluluPay id", () => {
  it("US-15: the alias is non-numeric, DM-ACCT- and eight letters", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (bytes) => {
        const alias = bankAlias((n) => Buffer.from(bytes).subarray(0, n));
        return /^DM-ACCT-[A-Z]{8}$/.test(alias);
      }),
    );
    expect(bankAlias()).not.toBe(bankAlias());
  });

  it("US-15: the DeluluPay id is the handle, or a random name, at delulu", () => {
    expect(delulupayId("moon-girl")).toBe("moon-girl@delulu");
    const random = delulupayId(null);
    expect(random).toMatch(/^dm-[a-z]{10}@delulu$/);
    expect(random.length).toBeLessThanOrEqual(64);
  });
});
