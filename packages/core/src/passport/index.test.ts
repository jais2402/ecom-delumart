import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { gradeQuiz, PASSPORT_RULE_VERSION, PASSPORT_V1, publicQuiz } from "./index";

const correct = (): Record<string, string> =>
  Object.fromEntries(PASSPORT_V1.questions.map((q) => [q.id, q.correctOptionId]));

describe("Inventor Passport quiz (passport_v1)", () => {
  it("US-05: three questions: fictional money, simulated delivery, simulated NPC buyers", () => {
    expect(PASSPORT_RULE_VERSION).toBe("passport_v1");
    expect(PASSPORT_V1.questions.map((q) => q.topic)).toEqual([
      "FICTIONAL_MONEY",
      "SIMULATED_DELIVERY",
      "SIMULATED_BUYERS",
    ]);
    for (const q of PASSPORT_V1.questions) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.options.filter((o) => o.id === q.correctOptionId)).toHaveLength(1);
      expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
    }
  });

  it("US-05: all three right passes, with the rule version", () => {
    expect(gradeQuiz(correct())).toEqual({ passed: true, wrong: [], ruleVersion: "passport_v1" });
  });

  it("US-05: a wrong or missing answer fails and names the question, not the right option", () => {
    const [q1, q2] = PASSPORT_V1.questions;
    if (!q1 || !q2) throw new Error("fixture");
    const wrongOption = q1.options.find((o) => o.id !== q1.correctOptionId)?.id ?? "";
    const answers = { ...correct(), [q1.id]: wrongOption };
    delete answers[q2.id];
    const graded = gradeQuiz(answers);
    expect(graded).toEqual({ passed: false, wrong: [q1.id, q2.id], ruleVersion: "passport_v1" });
    expect(JSON.stringify(graded)).not.toContain(q1.correctOptionId);
  });

  it("US-05: unknown question ids or option ids never pass", () => {
    expect(gradeQuiz({}).passed).toBe(false);
    expect(gradeQuiz({ ...correct(), extra: "x" }).passed).toBe(true); // extra keys are ignored
    const q = PASSPORT_V1.questions[0];
    if (!q) throw new Error("fixture");
    expect(gradeQuiz({ ...correct(), [q.id]: "not-an-option" }).wrong).toEqual([q.id]);
  });

  it("US-05 (property): the quiz passes exactly when every answer is the correct option", () => {
    const qs = PASSPORT_V1.questions;
    const answerArb = fc.tuple(
      ...qs.map((q) => fc.option(fc.constantFrom(...q.options.map((o) => o.id), "zz"), { nil: undefined })),
    );
    fc.assert(
      fc.property(answerArb, (picked) => {
        const answers: Record<string, string> = {};
        picked.forEach((a, i) => {
          const q = qs[i];
          if (q && a !== undefined) answers[q.id] = a;
        });
        const allRight = qs.every((q) => answers[q.id] === q.correctOptionId);
        const graded = gradeQuiz(answers);
        expect(graded.passed).toBe(allRight);
        expect(graded.wrong.length === 0).toBe(allRight);
      }),
    );
  });

  it("US-05: the public quiz carries no correct answers", () => {
    const shown = publicQuiz();
    expect(shown.ruleVersion).toBe("passport_v1");
    expect(shown.questions).toHaveLength(3);
    expect(JSON.stringify(shown)).not.toContain("correct");
  });
});
