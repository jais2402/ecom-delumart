/**
 * A FAKE Supabase Auth server for tests and the local production smoke (never used by the app).
 * It follows the documented GoTrue behaviour the provider relies on, over real HTTP:
 *
 *   GET  /auth/v1/.well-known/jwks.json         P-256 public keys (real key pairs, rotated on demand)
 *   POST /auth/v1/otp?redirect_to=              email: user created on first use, a 6-digit code and a
 *                                               link (redirect_to + ?code=<auth code>) "sent" to the outbox;
 *                                               phone (create_user false): a code to the user holding it
 *   GET  /auth/v1/authorize?provider=google     302 to redirect_to?code=<auth code> for `googleEmail`
 *   POST /auth/v1/token?grant_type=pkce         auth code + verifier (S256) → session; a code works once
 *   POST /auth/v1/verify                        type email | sms + token → session; sms sets phone_confirmed_at
 *   GET|PUT /auth/v1/admin/users/{id}           secret key only; PUT {phone} (422 when another user has it)
 *   POST /auth/v1/logout?scope=local            Bearer access token → that session ends
 *
 * Sessions are rows in the test database's auth.users / auth.sessions (as the real service writes
 * them). Knobs change what the next token looks like (wrong alg, kid, issuer, audience, expiry,
 * another project's key) or take the JWKS endpoint down. Every request is recorded (method, path,
 * which key it carried) for assertions.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";

export type TokenMode =
  | "valid"
  | "HS256"
  | "none"
  | "unknown-kid"
  | "expired"
  | "wrong-issuer"
  | "wrong-audience"
  | "other-project"
  | "user-mismatch";

interface KeyPair {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

interface FakeUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  phone: string | null;
  phoneConfirmedAt: string | null;
}

interface PendingCode {
  userId: string;
  codeChallenge: string | null;
  used: boolean;
}

export interface SentEmail {
  email: string;
  code: string;
  link: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  key: "publishable" | "secret" | "none" | "other";
  bearer: boolean;
}

function keyPair(): KeyPair {
  const kid = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig", key_ops: ["verify"] },
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export class FakeSupabase {
  readonly publishableKey = `sb_publishable_${randomBytes(12).toString("hex")}`;
  readonly secretKey = `sb_secret_${randomBytes(16).toString("hex")}`;
  url = "";
  keys: KeyPair[] = [keyPair()];
  private readonly otherProject = keyPair();
  readonly users = new Map<string, FakeUser>();
  readonly outbox: SentEmail[] = [];
  readonly sms: { phone: string; code: string }[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Every response body the fake sent (tokens included), for "never forwarded" assertions. */
  readonly issuedTokens: string[] = [];
  readonly refreshTokens: string[] = [];
  private readonly emailCodes = new Map<string, { code: string; userId: string; expiresAt: number }>();
  private readonly authCodes = new Map<string, PendingCode>();
  private readonly phoneCodes = new Map<string, { code: string; userId: string }>();
  tokenMode: TokenMode = "valid";
  jwksDown = false;
  /** Serve GET /__outbox (the standalone smoke runner only). */
  debugRoutes = false;
  /** The Google account the next /authorize signs in. */
  googleEmail = "google.player@example.test";
  private server: Server | undefined;
  private db: pg.Pool | undefined;

  /** `databaseUrl`: the database whose auth.* tables stand in for the service's (owner login). */
  async start(databaseUrl: string, port = 0): Promise<this> {
    this.db = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    const { port: actual } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${actual}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.db?.end();
  }

  get issuer(): string {
    return `${this.url}/auth/v1`;
  }

  rotateKey(): void {
    this.keys = [keyPair(), ...this.keys];
  }

  /** The last email the fake "sent" to the address. */
  lastEmail(email: string): SentEmail | undefined {
    return [...this.outbox].reverse().find((m) => m.email === email);
  }

  // ------------------------------------------------------------------ tokens

  private mint(userId: string, sessionId: string, mode: TokenMode = this.tokenMode): string {
    const now = Math.floor(Date.now() / 1000);
    const user = this.users.get(userId);
    const claims: Record<string, unknown> = {
      iss: mode === "wrong-issuer" ? "https://another-project.supabase.co/auth/v1" : this.issuer,
      aud: mode === "wrong-audience" ? "anon" : "authenticated",
      sub: userId,
      session_id: sessionId,
      role: "authenticated",
      email: user?.email ?? "",
      phone: user?.phone ?? "",
      aal: "aal1",
      is_anonymous: false,
      iat: mode === "expired" ? now - 7200 : now,
      exp: mode === "expired" ? now - 3600 : now + 3600,
    };
    const signer = mode === "other-project" ? this.otherProject : this.keys[0];
    if (!signer) throw new Error("no key");
    const kid = mode === "unknown-kid" ? randomUUID() : signer.kid;
    if (mode === "none") return `${b64({ alg: "none", typ: "JWT", kid })}.${b64(claims)}.`;
    if (mode === "HS256") {
      const head = b64({ alg: "HS256", typ: "JWT", kid });
      const body = b64(claims);
      const mac = createHash("sha256").update(`${head}.${body}`).digest("base64url");
      return `${head}.${body}.${mac}`;
    }
    const head = b64({ alg: "ES256", typ: "JWT", kid });
    const body = b64(claims);
    const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
      key: signer.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${head}.${body}.${sig.toString("base64url")}`;
  }

  private async newSession(userId: string): Promise<Record<string, unknown>> {
    const sessionId = randomUUID();
    await this.db?.query("INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
    await this.db?.query("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [sessionId, userId]);
    const accessToken = this.mint(userId, sessionId);
    const refreshToken = randomBytes(12).toString("base64url");
    this.issuedTokens.push(accessToken);
    this.refreshTokens.push(refreshToken);
    const user = this.users.get(userId);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: this.userJson(user, this.tokenMode === "user-mismatch" ? randomUUID() : userId),
    };
  }

  private userJson(user: FakeUser | undefined, id: string): Record<string, unknown> {
    return {
      id,
      aud: "authenticated",
      role: "authenticated",
      email: user?.email ?? "",
      email_confirmed_at: user?.emailConfirmedAt ?? null,
      phone: user?.phone ?? "",
      phone_confirmed_at: user?.phoneConfirmedAt ?? null,
    };
  }

  private userByEmail(email: string, create: boolean): FakeUser | null {
    for (const u of this.users.values()) if (u.email === email) return u;
    if (!create) return null;
    const user: FakeUser = {
      id: randomUUID(),
      email,
      emailConfirmedAt: null,
      phone: null,
      phoneConfirmedAt: null,
    };
    this.users.set(user.id, user);
    return user;
  }

  private issueAuthCode(userId: string, codeChallenge: string | null): string {
    const code = randomUUID();
    this.authCodes.set(code, { userId, codeChallenge, used: false });
    return code;
  }

  // ------------------------------------------------------------------ HTTP

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const apikey = req.headers.apikey;
    this.requests.push({
      method: req.method ?? "",
      path: url.pathname,
      key:
        apikey === undefined
          ? "none"
          : apikey === this.publishableKey
            ? "publishable"
            : apikey === this.secretKey
              ? "secret"
              : "other",
      bearer: typeof req.headers.authorization === "string",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const path = url.pathname;

    // the standalone runner's peek at the "sent" email and SMS (local smoke only)
    if (this.debugRoutes && req.method === "GET" && path === "/__outbox") {
      const to = url.searchParams.get("email");
      return json(200, {
        email: to ? (this.lastEmail(to) ?? null) : null,
        sms: this.sms[this.sms.length - 1] ?? null,
      });
    }

    if (req.method === "GET" && path === "/auth/v1/.well-known/jwks.json") {
      if (this.jwksDown) return void res.writeHead(503).end();
      return json(200, { keys: this.keys.map((k) => k.jwk) });
    }
    if (req.method === "GET" && path === "/auth/v1/authorize") {
      const redirectTo = url.searchParams.get("redirect_to") ?? "";
      if (
        url.searchParams.get("provider") !== "google" ||
        url.searchParams.get("code_challenge_method") !== "s256"
      ) {
        return json(400, { error: "bad_request" });
      }
      const user = this.userByEmail(this.googleEmail, true);
      if (!user) return json(500, {});
      user.emailConfirmedAt ??= new Date().toISOString();
      const code = this.issueAuthCode(user.id, url.searchParams.get("code_challenge"));
      const target = new URL(redirectTo);
      target.searchParams.set("code", code);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (apikey !== this.publishableKey && apikey !== this.secretKey)
      return json(401, { message: "No API key found" });

    if (req.method === "POST" && path === "/auth/v1/otp") {
      if (typeof body.email === "string") {
        const user = this.userByEmail(body.email, body.create_user === true);
        if (!user) return json(422, { error_code: "otp_disabled" });
        const code = String(randomInt(1_000_000)).padStart(6, "0");
        this.emailCodes.set(body.email, { code, userId: user.id, expiresAt: Date.now() + 3_600_000 });
        const authCode = this.issueAuthCode(
          user.id,
          typeof body.code_challenge === "string" ? body.code_challenge : null,
        );
        const target = new URL(url.searchParams.get("redirect_to") ?? this.url);
        target.searchParams.set("code", authCode);
        this.outbox.push({ email: body.email, code, link: target.toString() });
        return json(200, {});
      }
      if (typeof body.phone === "string") {
        const phone = body.phone.replace(/^\+/, "");
        const user = [...this.users.values()].find((u) => u.phone === phone);
        if (!user) return json(422, { error_code: "otp_disabled" });
        const code = String(randomInt(1_000_000)).padStart(6, "0");
        this.phoneCodes.set(phone, { code, userId: user.id });
        this.sms.push({ phone: `+${phone}`, code });
        return json(200, {});
      }
      return json(400, {});
    }
    if (req.method === "POST" && path === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const pending = this.authCodes.get(String(body.auth_code));
      const verifier = String(body.code_verifier ?? "");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!pending || pending.used || pending.codeChallenge !== challenge) {
        return json(400, { error_code: "flow_state_not_found" });
      }
      pending.used = true;
      const user = this.users.get(pending.userId);
      if (user) user.emailConfirmedAt ??= new Date().toISOString();
      return json(200, await this.newSession(pending.userId));
    }
    if (req.method === "POST" && path === "/auth/v1/verify") {
      if (body.type === "email" && typeof body.email === "string") {
        const pending = this.emailCodes.get(body.email);
        if (!pending || pending.code !== body.token || pending.expiresAt < Date.now()) {
          return json(403, { error_code: "otp_expired" });
        }
        this.emailCodes.delete(body.email);
        const user = this.users.get(pending.userId);
        if (user) user.emailConfirmedAt ??= new Date().toISOString();
        return json(200, await this.newSession(pending.userId));
      }
      if (body.type === "sms" && typeof body.phone === "string") {
        const phone = body.phone.replace(/^\+/, "");
        const pending = this.phoneCodes.get(phone);
        if (!pending || pending.code !== body.token) return json(403, { error_code: "otp_expired" });
        this.phoneCodes.delete(phone);
        const user = this.users.get(pending.userId);
        if (user) user.phoneConfirmedAt = new Date().toISOString();
        await this.db
          ?.query("UPDATE auth.users SET phone_confirmed_at = now() WHERE id = $1", [pending.userId])
          .catch(() => undefined); // the local stand-in has no such column
        return json(200, await this.newSession(pending.userId));
      }
      return json(400, {});
    }
    if (req.method === "POST" && path === "/auth/v1/logout") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!this.issuedTokens.includes(token)) return json(401, { error_code: "bad_jwt" });
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}") as {
        session_id?: string;
      };
      if (!claims.session_id) return json(401, {});
      await this.db?.query("DELETE FROM auth.sessions WHERE id = $1", [claims.session_id]);
      return void res.writeHead(204).end();
    }
    const admin = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path);
    if (admin?.[1]) {
      if (apikey !== this.secretKey) return json(403, { message: "User not allowed" });
      const user = this.users.get(admin[1]);
      if (!user) return json(404, { error_code: "user_not_found" });
      if (req.method === "PUT" && typeof body.phone === "string") {
        const phone = body.phone.replace(/^\+/, "");
        if ([...this.users.values()].some((u) => u.id !== user.id && u.phone === phone)) {
          return json(422, { error_code: "phone_exists" });
        }
        if (user.phone !== phone) user.phoneConfirmedAt = null;
        user.phone = phone;
      }
      return json(200, this.userJson(user, user.id));
    }
    return json(404, {});
  }
}
