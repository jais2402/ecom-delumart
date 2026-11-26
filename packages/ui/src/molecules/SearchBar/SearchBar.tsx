"use client";

import { Search } from "lucide-react";
import {
  type ComponentPropsWithRef,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  useId,
  useState,
} from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { cn } from "../../lib/cn";

export type SearchSuggestion = {
  id: string;
  /** What the row says, and what is spoken for it. */
  label: string;
  /** Where choosing it goes. */
  href: string;
  /** A short word after the label, such as "Product" or "Department". */
  kind: string;
};

export type SearchBarProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "role"> & {
  onSearch: (query: string) => void;
  defaultValue?: string;
  placeholder?: string;
  label?: string;
  /** "pill" is the large rounded search of the site header. */
  variant?: "default" | "pill";
  /**
   * When given (even empty), the field becomes a combobox with a listbox of these suggestions
   * under it. The parent decides when there are any (after a delay, from two characters on).
   */
  suggestions?: readonly SearchSuggestion[];
  /** Called with the text of the field as it changes, so the parent can look for suggestions. */
  onQueryChange?: (query: string) => void;
  /** Called when a suggestion is chosen; without it the browser goes to the suggestion's address. */
  onSelectSuggestion?: (suggestion: SearchSuggestion) => void;
};

/**
 * A search field. Plain, it is a form with a search box and a button, and it also works as a normal
 * GET form without JavaScript when given an `action`. With `suggestions` it follows the combobox
 * pattern: Arrow keys move through the list (focus stays in the field, the row is named by
 * aria-activedescendant), Enter on a row goes there, Enter with no row submits the plain search,
 * Escape closes the list.
 */
export function SearchBar({
  onSearch,
  defaultValue = "",
  placeholder = "Search DeluluMart",
  label = "Search",
  variant = "default",
  suggestions,
  onQueryChange,
  onSelectSuggestion,
  className,
  ...props
}: SearchBarProps) {
  const [query, setQuery] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (index: number) => `${uid}-option-${index}`;
  const pill = variant === "pill";
  const combo = suggestions !== undefined;
  const rows = suggestions ?? [];
  const listOpen = combo && open && rows.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOpen(false);
    onSearch(query.trim());
  }

  function choose(suggestion: SearchSuggestion) {
    setOpen(false);
    setActive(-1);
    if (onSelectSuggestion) onSelectSuggestion(suggestion);
    else window.location.assign(suggestion.href);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!combo) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      if (!listOpen) {
        setOpen(true);
        setActive(event.key === "ArrowDown" ? 0 : rows.length - 1);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + rows.length) % rows.length);
    } else if (event.key === "Enter" && listOpen && active >= 0) {
      const row = rows[active];
      if (row) {
        event.preventDefault();
        choose(row);
      }
    } else if (event.key === "Escape" && listOpen) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  function onBlur(event: FocusEvent<HTMLFormElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on form is the requested, widely supported pattern
    <form
      role="search"
      onSubmit={submit}
      onBlur={onBlur}
      className={cn("relative", pill ? "flex w-full" : "flex w-full gap-2", className)}
      {...props}
    >
      <Input
        type="search"
        name="q"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
          setOpen(true);
          onQueryChange?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
        {...(combo
          ? {
              role: "combobox",
              "aria-autocomplete": "list" as const,
              "aria-expanded": listOpen,
              "aria-controls": listId,
              ...(listOpen && active >= 0 ? { "aria-activedescendant": optionId(active) } : {}),
            }
          : {})}
        className={cn(
          "min-w-0 flex-1",
          pill &&
            "h-12 rounded-pill border-transparent pr-14 pl-5 font-medium focus-visible:outline-fg-on-band",
        )}
      />
      <Button
        type="submit"
        aria-label={label}
        className={cn(
          "shrink-0",
          pill &&
            "absolute top-0.5 right-0.5 size-11 rounded-pill bg-ink px-0 text-fg-on-ink hover:bg-ink/90",
        )}
      >
        <Search aria-hidden="true" className="size-4" />
      </Button>
      {combo ? (
        <>
          {listOpen ? (
            <div
              id={listId}
              role="listbox"
              aria-label="Search suggestions"
              className="absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-lg border border-border bg-surface py-2 text-fg shadow-overlay"
            >
              {rows.map((row, index) => (
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the field; aria-activedescendant names the row
                // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keys (arrows and Enter) for every row
                <div
                  key={row.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(row)}
                  className={cn(
                    "flex min-h-touch cursor-pointer items-center justify-between gap-3 px-5 font-body text-base",
                    index === active ? "bg-action-soft" : "hover:bg-surface-raised",
                  )}
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                  <span className="shrink-0 text-sm text-fg-muted">{row.kind}</span>
                </div>
              ))}
            </div>
          ) : null}
          <p role="status" className="sr-only">
            {listOpen ? `${rows.length} ${rows.length === 1 ? "suggestion" : "suggestions"} available` : ""}
          </p>
        </>
      ) : null}
    </form>
  );
}
