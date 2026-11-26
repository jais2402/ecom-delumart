"use client";

import { type ComponentPropsWithRef, useCallback, useRef, useState } from "react";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { CarouselControls } from "../../molecules/CarouselControls";
import { HeroSlide, type HeroSlideItem } from "../../molecules/HeroSlide";

export type HomeHeroProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  /** The page's one h1, shown in the slim banner under the carousel. */
  title: string;
  /** One line of subcopy beside it. */
  text: string;
  /** The featured products, one per slide. Nothing moves on its own. */
  slides: readonly HeroSlideItem[];
};

/**
 * A product-led hero: a large photo carousel (previous and next buttons, dots, swipe with
 * scroll-snap on touch) that only moves when asked, with a slim amber banner carrying the page's h1
 * beneath it (first in the markup so it is read first, last on screen; it has no controls). Slides out of view are inert, so Tab never lands on an unseen link.
 */
export function HomeHero({ title, text, slides, className, ...props }: HomeHeroProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || el.clientWidth === 0) return;
    setIndex(Math.min(Math.max(Math.round(el.scrollLeft / el.clientWidth), 0), slides.length - 1));
  }, [slides.length]);

  function show(next: number) {
    setIndex(next);
    const el = scroller.current;
    if (!el?.scrollTo) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollTo({ left: next * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  }

  return (
    <section className={cn("flex flex-col gap-3", className)} {...props}>
      <div className="order-last flex flex-col gap-0.5 rounded-lg bg-cta px-4 py-3 text-fg-on-cta sm:flex-row sm:items-baseline sm:justify-center sm:gap-x-4 md:px-6">
        <Heading level={1} size="md" className="text-lg leading-snug text-fg-on-cta md:text-xl">
          {title}
        </Heading>
        <p className="font-body text-sm text-fg-on-cta">{text}</p>
      </div>
      {slides.length > 0 ? (
        // biome-ignore lint/a11y/useSemanticElements: the carousel pattern is a group with aria-roledescription; a fieldset is for form fields
        <div role="group" aria-roledescription="carousel" aria-label="Featured products" className="min-w-0">
          <div
            ref={scroller}
            onScroll={onScroll}
            className="flex snap-x snap-mandatory overflow-x-auto rounded-lg scroll-smooth motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {slides.map((slide, i) => (
              // biome-ignore lint/a11y/useSemanticElements: the carousel pattern is a group with aria-roledescription; a fieldset is for form fields
              <div
                key={slide.id}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${slides.length}`}
                inert={i !== index}
                className="w-full min-w-0 shrink-0 snap-center"
              >
                <HeroSlide item={slide} eager={i === 0} />
              </div>
            ))}
          </div>
          <CarouselControls
            count={slides.length}
            index={index}
            onSelect={show}
            noun="featured product"
            className="mt-1"
          />
        </div>
      ) : null}
    </section>
  );
}
