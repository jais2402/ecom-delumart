import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Text } from "../../atoms/Text";
import { cn } from "../../lib/cn";
import type { CategoryLink } from "../../molecules/CategoryThumb";
import { SearchBar } from "../../molecules/SearchBar";

export type RecoveryPanelProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  /** The page's one h1, for example "We can't find that page". */
  title: string;
  /** A calm sentence saying what happened and what is safe. */
  message: ReactNode;
  /** Optional extra detail line, such as a reference. */
  detail?: ReactNode;
  /** A main action, such as "Try again". */
  action?: ReactNode;
  /** Search: a plain GET form to `searchAction`; `onSearch` takes the query and navigates. */
  searchAction: string;
  onSearch: (query: string) => void;
  /** Departments offered as quick links. */
  categories?: readonly CategoryLink[];
  homeHref?: string;
};

/**
 * What a shopper sees when a page is missing, unavailable or broken: one h1, one calm sentence, a
 * search, the popular departments and a way home. The same panel serves every such page so they feel
 * alike.
 */
export function RecoveryPanel({
  title,
  message,
  detail,
  action,
  searchAction,
  onSearch,
  categories = [],
  homeHref = "/",
  className,
  ...props
}: RecoveryPanelProps) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-col items-center gap-5 rounded-lg bg-surface px-4 py-8 text-center md:px-8 md:py-10",
        className,
      )}
      {...props}
    >
      <Heading level={1} size="lg">
        {title}
      </Heading>
      <Text muted className="max-w-reading">
        {message}
      </Text>
      {detail ? (
        <Text size="sm" muted>
          {detail}
        </Text>
      ) : null}
      <SearchBar
        variant="pill"
        action={searchAction}
        label="Search for a product"
        onSearch={onSearch}
        className="w-full max-w-md rounded-pill border border-border-strong"
      />
      <div className="flex flex-wrap justify-center gap-2">
        {action}
        <Button asChild variant={action ? "secondary" : "cta"}>
          <a href={homeHref}>Go to the home page</a>
        </Button>
      </div>
      {categories.length > 0 ? (
        <nav aria-label="Popular departments" className="flex flex-col items-center gap-1">
          <p className="font-body text-sm font-bold text-fg">Popular departments</p>
          <ul className="flex flex-wrap justify-center gap-x-4">
            {categories.map((category) => (
              <li key={category.slug}>
                <a
                  href={category.href}
                  className="inline-flex min-h-touch items-center font-body text-base text-action underline underline-offset-2 hover:text-action-hover"
                >
                  {category.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
