import { describe, expect, it } from "vitest";
import { connectionConfig, decodeCaCertificate, isLoopbackHost } from "../src/connection";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUfake\n-----END CERTIFICATE-----\n";

describe("database connection config (TLS for the managed database)", () => {
  it("verify-full: TLS with certificate and host name verification, the given CA, and no ssl parameters left in the URL", () => {
    const cfg = connectionConfig({
      url: "postgres://app_web.ref:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&sslrootcert=/x.crt&application_name=a",
      tls: "verify-full",
      caPem: PEM,
    });
    // a URL ssl parameter would OVERRIDE the ssl object in node-postgres, so none may remain
    expect(cfg.connectionString).toBe(
      "postgres://app_web.ref:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?application_name=a",
    );
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it("verify-full without a CA uses the system's trusted roots, still verifying", () => {
    const cfg = connectionConfig({
      url: "postgres://u:p@db.example:5432/postgres",
      tls: "verify-full",
      caPem: null,
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("disable: no TLS (local development and tests only)", () => {
    const cfg = connectionConfig({
      url: "postgres://u:p@127.0.0.1:5432/x?sslmode=disable",
      tls: "disable",
      caPem: null,
    });
    expect(cfg.ssl).toBe(false);
    expect(cfg.connectionString).toBe("postgres://u:p@127.0.0.1:5432/x");
  });

  it("the CA may be given as PEM text or as base64 of the PEM; anything else is refused", () => {
    expect(decodeCaCertificate(PEM)).toBe(PEM);
    expect(decodeCaCertificate(Buffer.from(PEM).toString("base64"))).toBe(PEM);
    expect(decodeCaCertificate("  \n")).toBeNull();
    expect(() => decodeCaCertificate("not a certificate")).toThrow(/PEM/);
  });

  it("loopback hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["db.abc.supabase.co", "10.0.0.1", "localhost.evil.example"])
      expect(isLoopbackHost(h)).toBe(false);
  });
});
