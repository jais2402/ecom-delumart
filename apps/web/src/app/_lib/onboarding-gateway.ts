/**
 * The only seam between the sign-in/onboarding screens and the backend.
 * Screens take a gateway from `useGateway()`: the real one lives in api-gateway.ts; the demo one
 * below serves the /design-system showcase only.
 * Methods reject with an Error whose message is safe to show to the player.
 */
export interface OnboardingGateway {
  startGoogleSignIn(): Promise<void>;
  requestEmailLink(email: string): Promise<void>;
  /** Triggers a verification code; `challenge` is the security check's one-use token, if any. */
  submitPhone(e164: string, challenge?: string | null): Promise<void>;
  verifyPhoneCode(code: string): Promise<void>;
  submitBirthdate(isoDate: string): Promise<void>;
  setPin(pin: string): Promise<void>;
  /**
   * The path of the first incomplete step for whoever is looking: a sign-in/onboarding path,
   * or "/account" when everything is done.
   */
  resolveStep(): Promise<string>;
  /** Card id and last four digits of the person's card, for the welcome screen. */
  welcomeCard(): Promise<{ cardId: string; lastFour: string } | null>;
  /** Shows the full (fictional) number of the card for display only; null if it cannot be shown. */
  revealCardNumber(cardId: string): Promise<string | null>;
}

/** The code the demo gateway accepts. Shown on screen in a labelled demo notice. */
export const DEMO_PHONE_CODE = "000000";
const DEMO_DELAY_MS = 400;

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, DEMO_DELAY_MS));

/**
 * In-memory stand-in. Nothing is sent, stored in the browser or logged: the module-level
 * variables below vanish on reload. Do not add console output or storage here.
 */
function createDemoGateway(): OnboardingGateway {
  let phoneSubmitted = false;
  let phoneVerified = false;
  let birthdateSubmitted = false;

  return {
    async startGoogleSignIn() {
      await wait();
    },
    async requestEmailLink() {
      await wait();
    },
    async submitPhone() {
      await wait();
      phoneSubmitted = true;
    },
    async verifyPhoneCode(code) {
      await wait();
      if (!phoneSubmitted) throw new Error("Request a code first.");
      if (code !== DEMO_PHONE_CODE) throw new Error("That code is not right. Check it and try again.");
      phoneVerified = true;
    },
    async submitBirthdate() {
      await wait();
      if (!phoneVerified) throw new Error("Verify your phone number first.");
      birthdateSubmitted = true;
    },
    async setPin() {
      await wait();
      if (!birthdateSubmitted) throw new Error("Add your birthdate first.");
    },
    async resolveStep() {
      return "/sign-in";
    },
    async welcomeCard() {
      return null;
    },
    async revealCardNumber() {
      return null;
    },
  };
}

export const demoGateway: OnboardingGateway = createDemoGateway();
