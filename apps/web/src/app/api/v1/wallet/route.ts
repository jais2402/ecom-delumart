import { DomainError } from "@delulu/core";
import { myWallet } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { walletView } from "@/server/views";

/** GET /api/v1/wallet: balance, bank alias, DeluluPay id and card summary; NOT_FOUND before provisioning. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const wallet = await myWallet(webPool(), { authSessionId: session.id });
  if (wallet === null) throw new DomainError("NOT_FOUND", "No account yet. Finish onboarding first.");
  return { json: walletView(wallet) };
});
