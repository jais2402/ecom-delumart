import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Text } from "./Text";

describe("Text", () => {
  it("renders its content as a paragraph by default", () => {
    render(<Text>Hello</Text>);
    expect(screen.getByText("Hello").tagName).toBe("P");
  });
  it("applies size and muted tokens", () => {
    render(
      <Text size="sm" muted>
        Quiet
      </Text>,
    );
    expect(screen.getByText("Quiet")).toHaveClass("text-sm", "text-fg-muted");
  });
  it("can render as a span and merges className", () => {
    render(
      <Text as="span" className="extra">
        Inline
      </Text>,
    );
    const el = screen.getByText("Inline");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("extra");
  });
});
