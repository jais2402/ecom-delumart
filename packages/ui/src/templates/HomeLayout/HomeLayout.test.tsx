import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomeLayout } from "./HomeLayout";

describe("HomeLayout", () => {
  it("places the slots in order: hero, promises, categories, rails, promos, story, steps, creator", () => {
    const { container } = render(
      <HomeLayout
        hero={<p>hero</p>}
        promises={<p>promises</p>}
        categories={<p>cats</p>}
        promos={<p>promos</p>}
        story={<p>story</p>}
        steps={<p>steps</p>}
        creator={<p>creator</p>}
      >
        <p>rails</p>
      </HomeLayout>,
    );
    expect(container.textContent).toBe("heropromisescatsrailspromosstorystepscreator");
    expect(screen.getByText("rails")).toBeInTheDocument();
  });
  it("merges the class name", () => {
    const { container } = render(
      <HomeLayout
        className="x-test"
        hero={null}
        promises={null}
        categories={null}
        promos={null}
        story={null}
        steps={null}
        creator={null}
      >
        {null}
      </HomeLayout>,
    );
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
