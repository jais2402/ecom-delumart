/**
 * Runs the FAKE Supabase Auth as a process, for the local production smoke only:
 *   DATABASE_URL=<owner url of the smoke database> FAKE_SUPABASE_PORT=3401 FAKE_SUPABASE_KEYS=<file> \
 *   node --experimental-strip-types --import ../../scripts/ts-resolve.mjs tests/helpers/run-fake-supabase.ts
 * It writes its (throwaway) publishable and secret keys to FAKE_SUPABASE_KEYS and serves GET /__outbox
 * and GET /__challenge?action= (a one-use token of its fake Turnstile verifier, which it serves at
 * /turnstile/v0/siteverify; FAKE_CAPTCHA_HOSTNAME sets the host name it reports).
 */
import { writeFileSync } from "node:fs";
import { FakeSupabase } from "./fake-supabase";

const fake = new FakeSupabase();
fake.debugRoutes = true;
// the host name the fake Turnstile verifier reports (the smoke's app origin host)
if (process.env.FAKE_CAPTCHA_HOSTNAME) fake.captchaHostname = process.env.FAKE_CAPTCHA_HOSTNAME;
await fake.start(process.env.DATABASE_URL ?? "", Number(process.env.FAKE_SUPABASE_PORT ?? "3401"));
writeFileSync(
  process.env.FAKE_SUPABASE_KEYS ?? "fake-supabase.json",
  JSON.stringify({ url: fake.url, publishableKey: fake.publishableKey, secretKey: fake.secretKey }),
);
process.stderr.write(`fake supabase on ${fake.url}\n`);
