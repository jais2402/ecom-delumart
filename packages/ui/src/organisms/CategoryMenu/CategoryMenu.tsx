"use client";

import type { CategoryLink } from "../../molecules/CategoryThumb";
import { LinkMenu } from "../../molecules/LinkMenu";

export type CategoryMenuProps = {
  categories: readonly CategoryLink[];
  className?: string;
};

/**
 * The "Departments" pill of the sub-navigation and the panel it opens: one row per category with a
 * chevron. Escape closes it and puts focus back on the button; so does a click outside or moving
 * focus out. Below 768px the panel is a full-width sheet at the bottom of the screen.
 */
export function CategoryMenu({ categories, className }: CategoryMenuProps) {
  return (
    <LinkMenu
      label="Departments"
      panelLabel="All departments"
      links={categories.map(({ name, href }) => ({ name, href }))}
      {...(className ? { className } : {})}
    />
  );
}
