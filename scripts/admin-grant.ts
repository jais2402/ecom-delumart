/**
 * pnpm admin:grant --confirm <project-ref> — makes ONE account the Super Admin, from the owner's own
 * terminal (never through the web app). The account must have signed in on the site and finished
 * the phone step first (that creates its profile).
 *
 *   DATABASE_CA_CERT_FILE=~/Downloads/prod-ca-2021.crt pnpm admin:grant --confirm <project-ref>
 * It asks for the owner connection string and its password at prompts that do not echo (or reads
 * DATABASE_URL_OWNER, with or without the password, from this terminal).
 *
 * It asks for IDENTITY_KEY (hidden; the same value as in Vercel) and the email address, computes
 * the keyed email fingerprint here (the database stores only that), and marks that profile
 * SUPER_ADMIN; any previous Super Admin becomes a player. The email and key are never printed,
 * stored or sent anywhere but into this computation; both prompts do not echo. ADMIN_EMAIL and
 * IDENTITY_KEY may instead be set in this terminal's environment (the runbook shows a hidden `read`).
 */
import { fingerprint, normalizeEmail } from "../packages/core/src/identity/index.ts";
import { grantSuperAdmin } from "../packages/db/src/prod-tools.ts";
import {
  ask,
  describeTarget,
  explain,
  fail,
  hasFlag,
  ownerPool,
  ownerTarget,
  say,
} from "./lib/owner-terminal.ts";

async function main(): Promise<void> {
  const { url, target } = await ownerTarget({ requireConfirm: true });
  say(`admin:grant: ${describeTarget(target)}`);
  const key = process.env.IDENTITY_KEY ?? (await ask("IDENTITY_KEY (64 hex characters, not shown): ", true));
  if (!/^[0-9a-fA-F]{64}$/.test(key)) fail("That is not a 64-character hex key.");
  const rawEmail =
    process.env.ADMIN_EMAIL ??
    (await ask("Email address of the account to make Super Admin (not shown): ", true));
  let fp: Buffer;
  try {
    fp = Buffer.from(fingerprint(Buffer.from(key, "hex"), normalizeEmail(rawEmail)), "hex");
  } catch {
    fail("That is not a valid email address.");
  }
  if (!hasFlag("--yes")) {
    const typed = await ask("Type the project ref again to go ahead: ");
    if (typed !== (target.loopback ? "local" : target.projectRef))
      fail("Not confirmed. Nothing was changed.");
  }
  const pool = ownerPool(url, target);
  try {
    const c = await pool.connect();
    try {
      const { outcome, replacedAnother } = await grantSuperAdmin(c, fp);
      const messages = {
        granted: `Done: that account is now the Super Admin${replacedAnother ? " (the previous Super Admin is now a player)" : ""}.`,
        already: "That account already is the Super Admin. Nothing changed.",
        "no-profile":
          "No account with that email has finished the phone step yet (or IDENTITY_KEY is not the one Vercel uses). " +
          "Sign in on the site, finish the phone step, then run this again. Nothing changed.",
        "not-active": "That account is suspended or deleted. Nothing changed.",
      } as const;
      say(messages[outcome]);
      if (outcome === "no-profile" || outcome === "not-active") process.exitCode = 1;
    } finally {
      c.release();
    }
  } catch (error) {
    say(`admin:grant failed: ${explain(error)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  say(`admin:grant failed: ${explain(error)}`);
  process.exit(1);
});
