/**
 * node-postgres connection settings for the managed database (Supabase), shared by the web server
 * and the owner scripts.
 *
 * TLS: "verify-full" encrypts AND verifies the server certificate and host name, against the
 * project's CA certificate when one is given (Supabase signs its database certificates with its own
 * root, which is not in the system store) or the system's trusted roots otherwise. "disable" is for
 * local development and tests on loopback only (the web server refuses it in production for any
 * other host).
 *
 * Every ssl-related parameter is REMOVED from the URL: node-postgres lets parameters parsed from
 * the connection string override the `ssl` object, so an `sslmode=require` copied from a dashboard
 * would silently replace the verification chosen here.
 */
export type DatabaseTls = "verify-full" | "disable";

export interface ConnectionConfigInput {
  url: string;
  tls: DatabaseTls;
  /** PEM text of the CA certificate, or null for the system roots. */
  caPem: string | null;
}

const SSL_PARAMS = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
];

export function connectionConfig(input: ConnectionConfigInput): {
  connectionString: string;
  ssl: false | { rejectUnauthorized: true; ca?: string };
} {
  const url = new URL(input.url);
  for (const name of SSL_PARAMS) url.searchParams.delete(name);
  const connectionString = url.toString().replace(/\?$/, "");
  if (input.tls === "disable") return { connectionString, ssl: false };
  return {
    connectionString,
    ssl: input.caPem === null ? { rejectUnauthorized: true } : { rejectUnauthorized: true, ca: input.caPem },
  };
}

/**
 * The CA certificate from an environment value: PEM text, or base64 of it (easier to paste into a
 * hosting dashboard that mangles newlines). Blank → null. Anything else throws.
 */
export function decodeCaCertificate(value: string | undefined | null): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return null;
  const pem = trimmed.includes("-----BEGIN CERTIFICATE-----")
    ? trimmed.replace(/\\n/g, "\n")
    : Buffer.from(trimmed, "base64").toString("utf8");
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(pem.trim())) {
    throw new Error("the CA certificate must be PEM text (-----BEGIN CERTIFICATE-----) or base64 of it");
  }
  return pem.trim().endsWith("\n") ? pem.trim() : `${pem.trim()}\n`;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}
