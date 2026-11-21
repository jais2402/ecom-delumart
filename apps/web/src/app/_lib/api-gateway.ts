import { api, type MeResponse, resetCsrf, type WalletResponse } from "./api";
import { markDevProvider } from "./dev-mode";
import type { OnboardingGateway } from "./onboarding-gateway";
import { nextOnboardingPath, refreshSession } from "./session-store";

/**
 * The real gateway: sign-in, phone, birthdate, account provisioning and PIN against /api/v1.
 * The code and PIN pass through here once and are never kept; only a flag that a code was
 * requested and the (public) card id live in module memory.
 */
let codeSent = false;
let devCodeShown: string | null = null;
let cardId: string | null = null;

/** The development code the server returned, for an on-screen notice. Memory only. */
export const devCode = (): string | null => devCodeShown;

async function me(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>("/api/v1/me");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "AUTH_REQUIRED") return null;
    throw error;
  }
}

export function createApiGateway(): OnboardingGateway {
  return {
    async startGoogleSignIn() {
      throw new Error("Not available in local development");
    },
    async requestEmailLink(email) {
      await api("/api/v1/auth/dev/sign-in", { method: "POST", body: { email } });
      resetCsrf(); // the CSRF token is now bound to the new session
      await refreshSession();
    },
    async submitPhone(e164) {
      const result = await api<{ sent: boolean; devCode?: string }>("/api/v1/onboarding/phone", {
        method: "POST",
        body: { phone: e164 },
      });
      codeSent = true;
      if (result.devCode) {
        devCodeShown = result.devCode;
        markDevProvider();
      }
    },
    async verifyPhoneCode(code) {
      await api("/api/v1/onboarding/phone/verify", { method: "POST", body: { code } });
      codeSent = false;
      devCodeShown = null;
      await refreshSession();
    },
    async submitBirthdate(isoDate) {
      await api("/api/v1/onboarding/birthdate", { method: "POST", body: { birthdate: isoDate } });
      // the account (wallet, card) opens as soon as the adult check has passed
      const created = await api<{ card: { id: string } }>("/api/v1/onboarding/provision", {
        method: "POST",
        body: {},
      });
      cardId = created.card.id;
      await refreshSession();
    },
    async setPin(pin) {
      if (cardId === null) {
        const current = await me();
        cardId = current?.account?.card?.id ?? null;
      }
      if (cardId === null) {
        const created = await api<{ card: { id: string } }>("/api/v1/onboarding/provision", {
          method: "POST",
          body: {},
        });
        cardId = created.card.id;
      }
      await api(`/api/v1/cards/${cardId}/pin`, { method: "POST", body: { pin } });
      await refreshSession();
    },
    async resolveStep() {
      const current = await me();
      if (current === null) return "/sign-in";
      return nextOnboardingPath(current.onboarding, codeSent);
    },
    async welcomeCard() {
      const wallet = await api<WalletResponse>("/api/v1/wallet");
      return wallet.card ? { cardId: wallet.card.id, lastFour: wallet.card.lastFour } : null;
    },
    async revealCardNumber(id) {
      try {
        const result = await api<{ cardNumber: string }>(`/api/v1/cards/${id}/reveal`, {
          method: "POST",
          body: {},
        });
        return result.cardNumber;
      } catch {
        return null;
      }
    },
  };
}

export const apiGateway: OnboardingGateway = createApiGateway();
