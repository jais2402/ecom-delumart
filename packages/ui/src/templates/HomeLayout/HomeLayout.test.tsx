import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeLayout } from "./HomeLayout";

describe("HomeLayout", () => {
  it("places the slots in order: categories, hero, featured, promos, rails, trust, steps, creator", () => {
    const { container } = render(
      <HomeLayout
        categories={<p>cats</p>}
        hero={<p>hero</p>}
        featured={<p>featured</p>}
        promos={<p>promos</p>}
        trust={<p>trust</p>}
        steps={<p>steps</p>}
        creator={<p>creator</p>}
      >
        <p>rails</p>
      </HomeLayout>,
    );
    expect(container.textContent).toBe("catsherofeaturedpromosrailstruststepscreator");
    expect(screen.getByText("rails")).toBeInTheDocument();
  });
  it("merges the class name", () => {
    const { container } = render(
      <HomeLayout
        className="x-test"
        hero={null}
        featured={null}
        promos={null}
        categories={null}
        trust={null}
        steps={null}
        creator={null}
      >
        {null}
      </HomeLayout>,
    );
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
