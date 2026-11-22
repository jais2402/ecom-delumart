import { myWallet, onboardingStatus, phoneVerificationMode } from "@delulu/db/runtime";
import { payPool, webPool } from "@/server/db";
import { route } from "@/server/http";
import { onboardingView, walletView } from "@/server/views";

/**
 * GET /api/v1/me: onboarding steps and a profile summary of the signed-in user, or 401, and how
 * the phone step works right now (phoneVerification: "sms" or "unverified", migration 0070).
 */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const authSessionId = session.id;
  const [status, wallet, phoneMode] = await Promise.all([
    onboardingStatus(payPool(), { authSessionId }),
    myWallet(webPool(), { authSessionId }),
    phoneVerificationMode(webPool()),
  ]);
  return {
    json: {
      onboarding: onboardingView(status),
      profile: session.actor.profile && { handle: session.actor.profile.handle },
      account: wallet && walletView(wallet),
      phoneVerification: phoneMode,
    },
  };
});
