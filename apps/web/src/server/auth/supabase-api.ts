import "../server-only";

/**
 * The few Supabase Auth (GoTrue) REST endpoints this server calls, as documented for supabase-js:
 *
 *   POST /auth/v1/otp?redirect_to=…        email link / code (PKCE: code_challenge, s256), or SMS code
 *   GET  /auth/v1/authorize?provider=google&redirect_to=…&code_challenge=…&code_challenge_method=s256
 *   POST /auth/v1/token?grant_type=pkce    {auth_code, code_verifier} → a session
 *   POST /auth/v1/verify                   {type: email | sms, email | phone, token} → a session
 *   POST /auth/v1/verify                   {type: email | magiclink | signup, token_hash} → a session
 *                                          (the emailed link, redeemed only after a button press)
 *   GET  /auth/v1/admin/users/{id}         (secret key) the user's email and phone state
 *   PUT  /auth/v1/admin/users/{id}         (secret key) {phone}; {phone: ""} clears an unconfirmed one
 *   POST /auth/v1/logout?scope=local       (the session's own access token) ends that session
 *
 * Public endpoints carry the publishable key in `apikey`; admin endpoints the SECRET key in
 * `apikey` only (new-style sb_secret_ keys are not JWTs and are not sent as a bearer). Every call
 * has a timeout, refuses redirects, reads at most `maxBytes`, and never logs a body, a token, a key
 * or an address: callers get the status and the parsed JSON, and log the status at most.
 *
 * A session returned by Supabase (access and refresh tokens) is handed to the caller and must not
 * leave the server; this server keeps neither token (see supabase.ts).
 */
export interface SupabaseApiConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
  timeoutMs: number;
  maxBytes: number;
  fetch?: typeof fetch;
}

/** The sign-in service could not be reached or failed (network, timeout, 5xx). */
export class SupabaseUnavailable extends Error {
  constructor(readonly status: number | null) {
    super("Supabase Auth unavailable");
    this.name = "SupabaseUnavailable";
  }
}

export interface ApiResult {
  status: number;
  json: Record<string, unknown>;
}

export interface SupabaseSession {
  accessToken: string;
  userId: string | null;
}

async function call(
  config: SupabaseApiConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  options: { admin?: boolean; bearer?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<ApiResult> {
  const url = new URL(`${config.url}/auth/v1${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    apikey: options.admin ? config.secretKey : config.publishableKey,
    accept: "application/json",
  };
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new SupabaseUnavailable(null);
  }
  if (response.status >= 500) throw new SupabaseUnavailable(response.status);
  const text = await response.text();
  if (text.length > config.maxBytes) throw new SupabaseUnavailable(response.status);
  let json: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        json = parsed as Record<string, unknown>;
    } catch {
      // a non-JSON answer: the status alone decides
    }
  }
  return { status: response.status, json };
}

function sessionOf(result: ApiResult): SupabaseSession | null {
  if (result.status !== 200) return null;
  const token = result.json.access_token;
  if (typeof token !== "string" || token.length === 0) return null;
  const user = result.json.user as { id?: unknown } | undefined;
  return { accessToken: token, userId: typeof user?.id === "string" ? user.id : null };
}

export function supabaseApi(config: SupabaseApiConfig) {
  return {
    /** Sends the email sign-in link / code for a PKCE flow; creates the user when new. */
    sendEmailOtp(email: string, input: { codeChallenge: string; redirectTo: string }): Promise<ApiResult> {
      return call(config, "POST", "/otp", {
        query: { redirect_to: input.redirectTo },
        body: {
          email,
          create_user: true,
          code_challenge: input.codeChallenge,
          code_challenge_method: "s256",
        },
      });
    },

    /** Where the browser goes to sign in with Google (Supabase redirects back with ?code=). */
    authorizeUrl(provider: "google", input: { codeChallenge: string; redirectTo: string }): string {
      const url = new URL(`${config.url}/auth/v1/authorize`);
      url.searchParams.set("provider", provider);
      url.searchParams.set("redirect_to", input.redirectTo);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "s256");
      return url.toString();
    },

    /** Exchanges the callback's code with this browser's verifier; null when refused. */
    async exchangeCode(authCode: string, codeVerifier: string): Promise<SupabaseSession | null> {
      return sessionOf(
        await call(config, "POST", "/token", {
          query: { grant_type: "pkce" },
          body: { auth_code: authCode, code_verifier: codeVerifier },
        }),
      );
    },

    /**
     * Redeems the token hash of an emailed link (the interstitial's POST); null when wrong, used or
     * expired. `type` is one of the email link types the server allows.
     */
    async verifyTokenHash(
      type: "email" | "magiclink" | "signup",
      tokenHash: string,
    ): Promise<{ session: SupabaseSession | null; email: string | null }> {
      const result = await call(config, "POST", "/verify", { body: { type, token_hash: tokenHash } });
      const user = result.json.user as { email?: unknown } | undefined;
      return {
        session: sessionOf(result),
        email: result.status === 200 && typeof user?.email === "string" ? user.email : null,
      };
    },

    /** Checks a typed email code; null when wrong or expired. */
    async verifyEmailCode(email: string, token: string): Promise<SupabaseSession | null> {
      return sessionOf(await call(config, "POST", "/verify", { body: { type: "email", email, token } }));
    },

    async adminGetUser(userId: string): Promise<ApiResult> {
      return call(config, "GET", `/admin/users/${encodeURIComponent(userId)}`, { admin: true });
    },

    async adminSetPhone(userId: string, e164: string): Promise<ApiResult> {
      return call(config, "PUT", `/admin/users/${encodeURIComponent(userId)}`, {
        admin: true,
        body: { phone: e164 },
      });
    },

    /**
     * Clears the user's phone number (an UNCONFIRMED hold being released; the caller checked it is
     * unconfirmed). Supabase's admin API is asked for an empty number; the caller re-reads the user
     * to see whether it took (docs/deploy-runbook.md §9 lists this as verify-on-first-deploy).
     */
    async adminClearPhone(userId: string): Promise<ApiResult> {
      return call(config, "PUT", `/admin/users/${encodeURIComponent(userId)}`, {
        admin: true,
        body: { phone: "" },
      });
    },

    /** Sends an SMS code to a number that already belongs to a user (never creates one). */
    sendPhoneOtp(e164: string): Promise<ApiResult> {
      return call(config, "POST", "/otp", { body: { phone: e164, create_user: false, channel: "sms" } });
    },

    async verifyPhoneCode(e164: string, token: string): Promise<SupabaseSession | null> {
      return sessionOf(await call(config, "POST", "/verify", { body: { type: "sms", phone: e164, token } }));
    },

    /** Ends the session the access token belongs to (scope local). */
    async logout(accessToken: string): Promise<boolean> {
      const result = await call(config, "POST", "/logout", {
        bearer: accessToken,
        query: { scope: "local" },
      });
      return result.status === 204 || result.status === 200;
    },
  };
}

export type SupabaseApi = ReturnType<typeof supabaseApi>;
