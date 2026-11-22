import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

describe("ninth review, minor 6: operations (runbook, scheduler workflow, bundle check)", () => {
  const runbook = repo("docs/deploy-runbook.md");
  const workflow = repo(".github/workflows/jobs-scheduler.yml");

  it("minor 6a: no secret is ever typed into a command line: no `export VAR='...'` for the owner URL, the app passwords or the admin email; a hidden read for bash and zsh", () => {
    expect(runbook).not.toMatch(/export\s+(DATABASE_URL_OWNER|APP_(WEB|PAY|JOBS)_PASSWORD|ADMIN_EMAIL)=/);
    expect(runbook).toContain("read -rsp 'DATABASE_URL_OWNER: ' DATABASE_URL_OWNER");
    expect(runbook).toContain("read -rs 'DATABASE_URL_OWNER?DATABASE_URL_OWNER: '");
    for (const name of ["APP_WEB_PASSWORD", "APP_PAY_PASSWORD", "APP_JOBS_PASSWORD", "ADMIN_EMAIL"]) {
      expect(runbook).toContain(name);
    }
    const terminal = repo("scripts/lib/owner-terminal.ts");
    expect(terminal).toMatch(/ask\(\s*"Owner connection string[^"]*not shown\): ",\s*true/);
    expect(terminal).toMatch(/Database password for \$\{[^}]+\} \(not shown\): `,\s*true/);
    expect(repo("scripts/db-migrate-prod.ts")).toMatch(
      /\(not shown; leave empty to keep the current password\): `,\s*true/,
    );
    expect(repo("scripts/admin-grant.ts")).toMatch(/Super Admin \(not shown\): ",\s*true/);
  });

  it("minor 6b/6c: both email templates carry the app's interstitial link (token hash) and the code; Supabase's captcha stays off", () => {
    expect(runbook).toContain("*Magic Link*");
    expect(runbook).toContain("*Confirm signup*");
    expect(runbook).toContain("{{ .SiteURL }}/sign-in/confirm?token_hash={{ .TokenHash }}&type=email");
    expect(runbook).toContain("{{ .Token }}");
    expect(runbook).toContain("Captcha protection: leave it OFF");
    expect(runbook).toContain("`https://<your-origin>/sign-in/confirm`");
  });

  it("minor 6d: the scheduler prints only the status and one count, has no pull_request trigger, no token permissions and no unpinned actions", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).not.toMatch(/pull_request/);
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
    expect(workflow).not.toMatch(/\bcat\b/);
    const dollar = "$";
    expect(workflow).toContain(`echo "HTTP ${dollar}{status}; listings screened: ${dollar}{screened}"`);
    for (const line of workflow.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) {
      expect(line).toMatch(/@[0-9a-f]{40}\b/);
    }
  });

  it("minor 6e: section 9 lists the reviewer's ten checks on the real deployment", () => {
    const section9 = runbook.slice(
      runbook.indexOf("## 9. Verify on first deploy"),
      runbook.indexOf("## 10."),
    );
    for (const topic of [
      "Admin PUT phone conflict behaviour",
      "Which template new `/otp` users get",
      '`/verify` with `type: "email"`',
      "Automatic identity linking with unconfirmed emails",
      "Per-IP limits vs Vercel egress",
      "X-Forwarded-For overwrite",
      "`app_*` logins through the pooler",
      "`postgres` can DELETE `auth.sessions`",
      "Link scanners",
      "Repository visibility for Actions logs",
    ]) {
      expect(section9, topic).toContain(topic);
    }
  });

  it("minor 6f / major 2a: Turnstile setup steps, both variables in the table, and the secret in the bundle check", () => {
    expect(runbook).toContain("### 2.7 Bot protection: Cloudflare Turnstile");
    expect(runbook).toContain("| `TURNSTILE_SITE_KEY` |");
    expect(runbook).toContain("| `TURNSTILE_SECRET_KEY` |");
    expect(repo("apps/web/scripts/check-client-bundle.mjs")).toContain('"TURNSTILE_SECRET_KEY"');
    const example = repo("apps/web/.env.example");
    expect(example).toContain("# TURNSTILE_SITE_KEY=");
    expect(example).toContain("# TURNSTILE_SECRET_KEY=");
  });

  it("major 2d: the runbook says Supabase's email quota and per-IP limits are shared by every user, and custom SMTP comes before real traffic", () => {
    expect(runbook).toContain("Supabase's limits are shared by EVERY user of the app");
    expect(runbook).toContain("**email quota**");
    expect(runbook).toContain("set up **custom SMTP**");
  });
});
