"use client";

import { type ComponentPropsWithRef, type FormEvent, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { Radio } from "../../atoms/Radio";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export type PassportQuizQuestion = {
  id: string;
  prompt: string;
  options: readonly { id: string; label: string }[];
};

export type PassportQuizProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "children"> & {
  questions: readonly PassportQuizQuestion[];
  /** Ids of the questions answered wrongly on the last try; null before any try. */
  wrong: readonly string[] | null;
  onSubmit: (answers: Record<string, string>) => void;
  loading?: boolean;
  /** A problem that is not about an answer (the network, a rate limit). */
  error?: string;
};

/**
 * The passport quiz: one fieldset per question. A failed try marks which questions to look at again
 * and never reveals the right options; retries are unlimited and the tone stays calm.
 */
export function PassportQuiz({
  questions,
  wrong,
  onSubmit,
  loading = false,
  error,
  className,
  ...props
}: PassportQuizProps) {
  const uid = useId();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);

  function choose(questionId: string, optionId: string) {
    setMissing(false);
    setAnswers((current) => ({ ...current, [questionId]: optionId }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (questions.some((q) => !answers[q.id])) {
      setMissing(true);
      return;
    }
    onSubmit(answers);
  }

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-4 font-body", className)} {...props}>
      {wrong && wrong.length > 0 ? (
        <Alert tone="info" title="Not quite yet">
          {wrong.length === 1 ? "One answer" : `${wrong.length} answers`} could use another look. They are
          marked below. You can try as many times as you like.
        </Alert>
      ) : null}
      {missing ? <Alert tone="warning">Pick an answer for every question, then check again.</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {questions.map((question, index) => {
        const isWrong = wrong?.includes(question.id) ?? false;
        const noteId = `${uid}-${question.id}-note`;
        return (
          <fieldset
            key={question.id}
            aria-describedby={isWrong ? noteId : undefined}
            className={cn(
              "flex flex-col gap-1 rounded-md border p-3",
              isWrong ? "border-info bg-info-soft" : "border-border",
            )}
          >
            <legend className="px-1 text-base font-medium text-fg">
              {index + 1}. {question.prompt}
            </legend>
            {question.options.map((option) => (
              <Radio
                key={option.id}
                name={`${uid}-${question.id}`}
                value={option.id}
                label={option.label}
                checked={answers[question.id] === option.id}
                onChange={() => choose(question.id, option.id)}
              />
            ))}
            {isWrong ? (
              <p id={noteId} className="text-sm font-medium text-info">
                Take another look at this one.
              </p>
            ) : null}
          </fieldset>
        );
      })}
      <Button type="submit" loading={loading} className="self-start">
        Check my answers
      </Button>
    </form>
  );
}
