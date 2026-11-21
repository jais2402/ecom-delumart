import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PassportQuiz } from "./PassportQuiz";

const questions = [
  {
    id: "q1",
    prompt: "What is the money?",
    options: [
      { id: "a", label: "Real" },
      { id: "b", label: "Play" },
    ],
  },
  {
    id: "q2",
    prompt: "What ships?",
    options: [
      { id: "c", label: "A parcel" },
      { id: "d", label: "Nothing real" },
    ],
  },
];

describe("PassportQuiz", () => {
  it("gives each question a fieldset named by its prompt", () => {
    render(<PassportQuiz questions={questions} wrong={null} onSubmit={() => {}} />);
    expect(screen.getByRole("group", { name: /What is the money\?/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /What ships\?/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });
  it("asks for every answer before submitting, then submits the chosen options", async () => {
    const onSubmit = vi.fn();
    render(<PassportQuiz questions={questions} wrong={null} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("radio", { name: "Play" }));
    await userEvent.click(screen.getByRole("button", { name: "Check my answers" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Pick an answer for every question/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Nothing real" }));
    await userEvent.click(screen.getByRole("button", { name: "Check my answers" }));
    expect(onSubmit).toHaveBeenCalledWith({ q1: "b", q2: "d" });
  });
  it("marks only the wrong questions and keeps the tone calm", () => {
    render(<PassportQuiz questions={questions} wrong={["q2"]} onSubmit={() => {}} />);
    expect(screen.getByText(/as many times as you like/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /What ships\?/ })).toHaveAccessibleDescription(
      "Take another look at this one.",
    );
    expect(screen.getByRole("group", { name: /What is the money\?/ })).not.toHaveAccessibleDescription();
  });
});
