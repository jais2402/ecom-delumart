"use client";

import {
  Alert,
  Button,
  ConceptForm,
  EmptyState,
  PassportQuiz,
  PassportStepCard,
  Price,
  Text,
} from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../_lib/api";
import { parsePaise } from "../../_lib/money";
import {
  CONCEPT_LIMITS,
  errorCodeOf,
  type PassportProgress,
  type PassportResponse,
  reasonsByField,
  type SavedPage,
  sellingErrorText,
} from "../../_lib/selling";
import { useApiGet } from "../../_lib/use-api";
import { useRequireAccount } from "../../_lib/use-require-account";
import { ErrorBlock, LoadingBlock } from "../LoadState";
import { PageHeading } from "../PageHeading";

interface QuizResult {
  passed: boolean;
  wrong: string[];
  passport: PassportProgress;
}

/** /sell/passport: three steps, usable in any order. Finishing the third takes you back to /sell. */
export function PassportPanel() {
  const { ok } = useRequireAccount();
  const router = useRouter();
  const loaded = useApiGet<PassportResponse>(ok ? "/api/v1/passport" : null);
  const saved = useApiGet<SavedPage>(ok ? "/api/v1/saves?limit=10" : null);
  const [progress, setProgress] = useState<PassportProgress | null>(null);
  const [wrong, setWrong] = useState<string[] | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const [quizError, setQuizError] = useState<string | undefined>();
  const [conceptBusy, setConceptBusy] = useState(false);
  const [conceptReasons, setConceptReasons] = useState<string[]>([]);
  const [conceptError, setConceptError] = useState<string | null>(null);

  function adopt(next: PassportProgress) {
    setProgress(next);
    if (next.completedAt) router.replace("/sell");
  }

  async function submitQuiz(answers: Record<string, string>) {
    setQuizBusy(true);
    setQuizError(undefined);
    try {
      const result = await api<QuizResult>("/api/v1/passport/quiz", { method: "POST", body: { answers } });
      setWrong(result.passed ? [] : result.wrong);
      adopt(result.passport);
    } catch (error) {
      setQuizError(sellingErrorText(error));
    } finally {
      setQuizBusy(false);
    }
  }

  async function submitConcept(concept: string) {
    setConceptBusy(true);
    setConceptReasons([]);
    setConceptError(null);
    try {
      adopt(await api<PassportProgress>("/api/v1/passport/concept", { method: "POST", body: { concept } }));
    } catch (error) {
      const reasons = reasonsByField(error);
      const mine = reasons.concept ?? [];
      const others = Object.entries(reasons)
        .filter(([field]) => field !== "concept")
        .flatMap(([, list]) => list);
      setConceptReasons(mine);
      if (errorCodeOf(error) !== "VALIDATION_FAILED" || (mine.length === 0 && others.length === 0)) {
        setConceptError(sellingErrorText(error));
      }
    } finally {
      setConceptBusy(false);
    }
  }

  if (!ok || loaded.status === "loading") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading>Inventor Passport</PageHeading>
        <LoadingBlock label="Loading your passport" />
      </div>
    );
  }
  if (loaded.status === "error") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeading>Inventor Passport</PageHeading>
        <ErrorBlock message={loaded.message} onRetry={loaded.reload} />
      </div>
    );
  }

  const passport = progress ?? loaded.data;
  const { quiz, saves, concept } = passport.steps;
  const savedItems = saved.status === "ready" ? saved.data.items : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Inventor Passport</PageHeading>
      <Text className="max-w-reading">
        Three small steps, in any order. It is free, there is no timer, and you can leave and come back
        whenever you like.
      </Text>
      {passport.completedAt ? (
        <Alert tone="success" title="Your passport is complete">
          <a className="text-action underline" href="/sell">
            Back to creator access
          </a>
        </Alert>
      ) : null}

      <PassportStepCard
        title="1. Short quiz"
        done={quiz.done}
        summary={quiz.done ? "You passed the quiz." : "A few questions about how DeluluMart works."}
      >
        {quiz.done ? null : (
          <PassportQuiz
            questions={loaded.data.quiz.questions}
            wrong={wrong}
            loading={quizBusy}
            {...(quizError ? { error: quizError } : {})}
            onSubmit={(answers) => void submitQuiz(answers)}
          />
        )}
      </PassportStepCard>

      <PassportStepCard
        title="2. Save three products"
        done={saves.done}
        summary={`${saves.count} of ${saves.required} saved. Saving is how you mark things you might want later.`}
      >
        {saved.status === "ready" && savedItems.length === 0 ? (
          <EmptyState
            title="Nothing saved yet"
            description="Tap the heart on any product to save it."
            headingLevel={3}
          />
        ) : null}
        {savedItems.length > 0 ? (
          <ul aria-label="Products you have saved" className="flex flex-col gap-1">
            {savedItems.map((item) => (
              <li
                key={item.productId}
                className="flex flex-wrap items-baseline justify-between gap-x-3 text-base"
              >
                {item.published ? (
                  <a
                    className="inline-flex min-h-touch items-center text-action underline"
                    href={`/p/${item.productId}`}
                  >
                    {item.name}
                  </a>
                ) : (
                  <span className="inline-flex min-h-touch items-center">
                    {item.name} (no longer available)
                  </span>
                )}
                <Price amountPaise={parsePaise(item.pricePaise)} className="text-sm" />
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <a href="/">Browse products</a>
          </Button>
          <Button asChild variant="ghost">
            <a href="/account/saved">All saved products</a>
          </Button>
        </div>
      </PassportStepCard>

      <PassportStepCard
        title="3. Your invention concept"
        done={concept.done}
        summary={
          concept.done
            ? "Saved. You can change it any time."
            : "One idea for something impossible, in a few sentences."
        }
      >
        {conceptError ? <Alert tone="danger">{conceptError}</Alert> : null}
        <ConceptForm
          minChars={CONCEPT_LIMITS.minChars}
          maxChars={CONCEPT_LIMITS.maxChars}
          initialText={concept.text ?? ""}
          reasons={conceptReasons}
          loading={conceptBusy}
          submitLabel={concept.done ? "Update my concept" : "Save my concept"}
          onSubmit={(text) => void submitConcept(text)}
        />
      </PassportStepCard>
    </div>
  );
}
