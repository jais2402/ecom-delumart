import { myWallet, onboardingStatus } from "@delulu/db/runtime";
import { payPool, webPool } from "@/server/db";
import { route } from "@/server/http";
import { onboardingView, walletView } from "@/server/views";

/** GET /api/v1/me: onboarding steps and a profile summary of the signed-in user, or 401. */
export const GET = route({ auth: "session" }, async ({ session }) => {
  const authSessionId = session.id;
  const [status, wallet] = await Promise.all([
    onboardingStatus(payPool(), { authSessionId }),
    myWallet(webPool(), { authSessionId }),
  ]);
  return {
    json: {
      onboarding: onboardingView(status),
      profile: session.actor.profile && { handle: session.actor.profile.handle },
      account: wallet && walletView(wallet),
    },
  };
});
