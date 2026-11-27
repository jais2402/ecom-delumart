/**
 * Draft policy text, for legal review. It describes what the product does today (from the PRD's
 * privacy commitments and docs/decisions.md) and leaves everything that needs a lawyer, a company
 * or a jurisdiction as a bracketed placeholder. Nothing here is a legal claim. A qualified person
 * must review and replace it before any real user is invited.
 */

export type PolicyBlock = string | { list: readonly string[] };

export interface PolicySection {
  id: string;
  title: string;
  blocks: readonly PolicyBlock[];
}

export interface PolicyDocument {
  slug: "terms" | "privacy" | "research";
  title: string;
  /** One line under the title. */
  summary: string;
  sections: readonly PolicySection[];
}

export const DRAFT_NOTICE_TITLE = "Draft for legal review: not yet in force";
export const DRAFT_NOTICE_TEXT =
  "This page is a working draft. It has not been reviewed by a qualified person, it does not bind anyone, and parts in [square brackets] are placeholders to be filled in or replaced.";

const PLACEHOLDER_CONTACT = "[Contact for privacy requests]";

export const TERMS: PolicyDocument = {
  slug: "terms",
  title: "Terms of use",
  summary: "The rules for using DeluluMart.",
  sections: [
    {
      id: "who",
      title: "Who provides DeluluMart",
      blocks: [
        "DeluluMart is provided by [Company legal name], [registered address and registration number].",
        "Questions about these terms: [Contact for legal questions].",
      ],
    },
    {
      id: "fictional",
      title: "Fictional money and no real goods",
      blocks: [
        {
          list: [
            "All money on DeluluMart is fictional. It has no value outside the game and cannot be bought, sold, cashed out, gifted, lent or transferred between accounts.",
            "Every account receives one starting balance of fictional money.",
            "Nothing real is sold or shipped. Products are imaginary and delivery is simulated.",
          ],
        },
      ],
    },
    {
      id: "accounts",
      title: "Accounts",
      blocks: [
        {
          list: [
            "One account per person. An account needs a verified email address and a phone number.",
            "Minimum age: [Minimum age to be set by legal review]. The date of birth given at sign-up is self-declared.",
            "You are responsible for keeping your sign-in and your game PIN to yourself.",
          ],
        },
      ],
    },
    {
      id: "payments",
      title: "Payments are a simulation",
      blocks: [
        "DeluluPay is a game feature. It moves fictional money only.",
        {
          list: [
            "Do not enter real card numbers, expiry dates, CVVs, UPI PINs or bank passwords anywhere on DeluluMart. No field asks for them.",
            "Use a PIN for the game only, never the PIN of a real card or payment app.",
          ],
        },
      ],
    },
    {
      id: "selling",
      title: "Shops and listings",
      blocks: [
        {
          list: [
            "Anyone may open a shop once they have unlocked creator access.",
            "Listings are screened automatically and some are reviewed by a person. A listing can be turned down, hidden or removed, and the shop owner can appeal.",
            "A shop owner is responsible for what they list. Fees and the way sale prices and reference prices are shown are described in the Help centre.",
            "[Rules about content that is not allowed: to be written with legal review.]",
          ],
        },
      ],
    },
    {
      id: "reviews-reports",
      title: "Reviews and reports",
      blocks: [
        {
          list: [
            "Only people who own a product can review it. Reviews are screened and can be hidden by the marketplace administrator for breaking the rules.",
            "Products and shops can be reported. Reports are looked at by a person.",
          ],
        },
      ],
    },
    {
      id: "use",
      title: "Acceptable use",
      blocks: ["[Acceptable use rules: to be written with legal review.]"],
    },
    {
      id: "changes",
      title: "Changes, suspension and ending",
      blocks: [
        "[How these terms can change, how notice is given, when an account may be suspended or closed, and what happens to an account when it is closed: to be written with legal review.]",
      ],
    },
    {
      id: "law",
      title: "Governing law and disputes",
      blocks: ["[Governing law, jurisdiction and dispute process: to be decided by legal review.]"],
    },
  ],
};

export const PRIVACY: PolicyDocument = {
  slug: "privacy",
  title: "Privacy notice",
  summary: "What DeluluMart collects about you, why, and what you can control.",
  sections: [
    {
      id: "who",
      title: "Who is responsible",
      blocks: [
        "The controller of your data is [Company legal name], [registered address].",
        `Privacy requests and questions: ${PLACEHOLDER_CONTACT}. [Data protection officer, if one is required.]`,
      ],
    },
    {
      id: "collected",
      title: "What is collected",
      blocks: [
        {
          list: [
            "Account details: your email address and your phone number with country code.",
            "Your date of birth, given once when your card is issued. It is stored encrypted and visible only to you.",
            "Saved delivery addresses, if you add any. They are stored encrypted and visible only to you.",
            "Your handle, if you set one, and your privacy choices.",
            "What you do in the game: orders, payments, wallet and card activity, reviews, reports, saved products.",
            "Usage events, for example pages viewed and steps completed in checkout. They carry no names, email addresses, phone numbers, addresses or card numbers.",
            "An approximate place (country, region and city) worked out from your connection, for usage statistics. Your connection address itself is not stored with these events. It is an estimate and can be wrong.",
          ],
        },
        "Your game PIN is stored only as a protected hash that cannot be reversed. It is never shown, logged or sent.",
      ],
    },
    {
      id: "why",
      title: "Why it is collected",
      blocks: [
        {
          list: [
            "To run your account, your purchases, your wallet and your shop.",
            "To verify your phone number and to keep one account per person.",
            "To keep the service safe: reports, moderation, fraud prevention.",
            "To measure how the service is used, and for research and product experiments (see the research notice).",
            "[Legal basis for each purpose: to be set by legal review.]",
          ],
        },
      ],
    },
    {
      id: "sharing",
      title: "Who can see it",
      blocks: [
        {
          list: [
            "Sellers never see your delivery address or any location for an order. By your choice they may see your handle on an order, never your name.",
            "Your phone number is visible only to you.",
            "Staff see personal data only through specific permissions, and each such view is recorded. [Staff access rules: to be confirmed.]",
            "Statistics shown to the marketplace administrator are aggregates. A place with fewer than 10 accounts is folded into “Other”.",
            "[Service providers and any transfers outside India: to be listed once providers are chosen.]",
          ],
        },
      ],
    },
    {
      id: "retention",
      title: "How long it is kept",
      blocks: [
        "[Retention periods: to be confirmed by the privacy reviewer.] The build currently works to these figures, which are not commitments until confirmed:",
        {
          list: [
            "Raw usage events: [30 days, then archived; to be confirmed].",
            "De-identified research data: [retention period to be confirmed].",
            "After an account is deleted its email and phone number are erased. A one-way fingerprint of each may be kept for [12 months; to be confirmed] only so that a returning person does not receive a second starting balance.",
          ],
        },
      ],
    },
    {
      id: "controls",
      title: "Your controls",
      blocks: [
        {
          list: [
            "Addresses: add, change or delete them at any time under Account, Addresses. Deleting an address removes it from past orders.",
            "Privacy switches on your profile: a public shelf, your collector level, your handle on orders.",
            "Research opt-out on your profile (see the research notice).",
            "[Access to your data, a copy of your data, correction, and deletion of your account: not available in the app yet. How to ask, and how fast we answer, to be written with legal review.]",
            "[How to complain to a regulator: to be completed with legal review.]",
          ],
        },
      ],
    },
    {
      id: "cookies",
      title: "Cookies and browser storage",
      blocks: [
        "[List of cookies and browser storage used, and what each is for: to be completed from the build.]",
      ],
    },
    {
      id: "changes",
      title: "Changes to this notice",
      blocks: ["[How changes are announced: to be written with legal review.]"],
    },
  ],
};

export const RESEARCH: PolicyDocument = {
  slug: "research",
  title: "Research and experiments",
  summary: "How play on DeluluMart is used for research, and how to opt out.",
  sections: [
    {
      id: "what",
      title: "What this is",
      blocks: [
        "DeluluMart is a game and also a place to study how people shop, pay, choose delivery, react to prices and promotions, and run shops, and to try out product ideas. Because the money and goods are fictional, nothing you do here has real-world consequences.",
        "[Statement of the research purposes and who carries it out: to be written with legal review.]",
      ],
    },
    {
      id: "used",
      title: "What is used",
      blocks: [
        {
          list: [
            "Activity in the game, in de-identified form: your account id is replaced by a random research id that cannot be linked back to you by researchers, your date of birth becomes an age band, and place is kept only as country and region, never for a group of fewer than 10 accounts.",
            "Fictional amounts and times are kept as they are.",
            "No email address, phone number, address, name or card number is in the research data.",
          ],
        },
      ],
    },
    {
      id: "experiments",
      title: "Experiments",
      blocks: [
        "Different people may see different versions of a feature at the same time, so that versions can be compared. Experiments may not weaken any security, privacy, moderation or accessibility control, and may not use countdown pressure or fabricated scarcity.",
      ],
    },
    {
      id: "optout",
      title: "Opting out",
      blocks: [
        "You can opt out under Account, Profile, Research. After you opt out, your play is left out of research datasets built afterwards and out of non-essential experiments. Playing is unaffected.",
        "[Whether data already in a dataset can be withdrawn: to be decided by legal review.]",
      ],
    },
    {
      id: "retention",
      title: "How long research data is kept",
      blocks: [
        "[Retention period for the de-identified research data: to be confirmed by the privacy reviewer.]",
      ],
    },
    {
      id: "basis",
      title: "Legal basis",
      blocks: [
        "[Whether notice and terms are enough for this research use, whether an exemption applies, and whether a separate consent is needed: an open question for the privacy reviewer.]",
      ],
    },
  ],
};
