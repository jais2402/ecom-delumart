/**
 * The Inventor Passport (US-05): the free route to creator access. Pure data and grading.
 *
 * Three steps, any order, no timers, unlimited retries: (1) this quiz, graded by the web server
 * from the data below; (2) three distinct published products saved; (3) a private invention
 * concept that passes text screening. The database records only whether the quiz passed and the
 * rule version it was graded under (never the answers), checks the saves and the concept length
 * itself, and grants the entitlement once all three are done.
 *
 * Versioned: a change to the questions, the answers or the step rules is a new rule version.
 */

export const PASSPORT_RULE_VERSION = "passport_v1";

export type PassportTopic = "FICTIONAL_MONEY" | "SIMULATED_DELIVERY" | "SIMULATED_BUYERS";

export interface PassportOption {
  id: string;
  label: string;
}

export interface PassportQuestion {
  id: string;
  topic: PassportTopic;
  prompt: string;
  options: readonly PassportOption[];
  correctOptionId: string;
}

export interface PassportRules {
  ruleVersion: string;
  /** Distinct published products the person must have saved. */
  savesRequired: number;
  /** Invention concept length in characters, after trimming. */
  concept: { minChars: number; maxChars: number };
  questions: readonly PassportQuestion[];
}

export const PASSPORT_V1: PassportRules = {
  ruleVersion: PASSPORT_RULE_VERSION,
  savesRequired: 3,
  concept: { minChars: 20, maxChars: 280 },
  questions: [
    {
      id: "q-money",
      topic: "FICTIONAL_MONEY",
      prompt: "What is the money in your DeluluMart wallet?",
      options: [
        { id: "opt-money-real", label: "Real rupees I can withdraw to my bank" },
        { id: "opt-money-play", label: "Fictional play money with no real-world value" },
        { id: "opt-money-voucher", label: "Store credit I can spend on other websites" },
      ],
      correctOptionId: "opt-money-play",
    },
    {
      id: "q-delivery",
      topic: "SIMULATED_DELIVERY",
      prompt: "When someone buys your invention, what gets delivered?",
      options: [
        { id: "opt-delivery-courier", label: "A courier picks up a parcel from my home" },
        { id: "opt-delivery-sim", label: "Nothing real ships: delivery is a simulation" },
        { id: "opt-delivery-post", label: "The platform posts a printed copy to the buyer" },
      ],
      correctOptionId: "opt-delivery-sim",
    },
    {
      id: "q-buyers",
      topic: "SIMULATED_BUYERS",
      prompt: "Some shoppers in the store are simulated NPC buyers. What are they?",
      options: [
        { id: "opt-buyers-people", label: "Real players who chose to stay anonymous" },
        { id: "opt-buyers-staff", label: "DeluluMart staff testing the store" },
        { id: "opt-buyers-sim", label: "Simulated buyers, not real players" },
      ],
      correctOptionId: "opt-buyers-sim",
    },
  ],
};

export interface QuizGrade {
  passed: boolean;
  /** Ids of the questions answered wrongly or not at all, in question order. */
  wrong: string[];
  ruleVersion: string;
}

/**
 * Grades answers (question id → option id) against `rules`. Passes only when every question has
 * its correct option; unknown question ids are ignored. The result names wrong questions only,
 * never the right options, so it can be shown to the person as it is.
 */
export function gradeQuiz(
  answers: Readonly<Record<string, string>>,
  rules: PassportRules = PASSPORT_V1,
): QuizGrade {
  const wrong = rules.questions
    .filter((q) => !Object.hasOwn(answers, q.id) || answers[q.id] !== q.correctOptionId)
    .map((q) => q.id);
  return { passed: wrong.length === 0, wrong, ruleVersion: rules.ruleVersion };
}

/** The quiz as shown to a person: questions and options, without the correct answers. */
export function publicQuiz(rules: PassportRules = PASSPORT_V1): {
  ruleVersion: string;
  questions: { id: string; topic: PassportTopic; prompt: string; options: PassportOption[] }[];
} {
  return {
    ruleVersion: rules.ruleVersion,
    questions: rules.questions.map((q) => ({
      id: q.id,
      topic: q.topic,
      prompt: q.prompt,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}
