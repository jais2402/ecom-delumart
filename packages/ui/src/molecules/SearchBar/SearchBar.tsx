"use client";

import { Search } from "lucide-react";
import { type ComponentPropsWithRef, type FormEvent, useState } from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { cn } from "../../lib/cn";

export type SearchBarProps = Omit<ComponentPropsWithRef<"form">, "onSubmit" | "role"> & {
  onSearch: (query: string) => void;
  defaultValue?: string;
  placeholder?: string;
  label?: string;
  /** "pill" is the large rounded search of the site header. */
  variant?: "default" | "pill";
};

export function SearchBar({
  onSearch,
  defaultValue = "",
  placeholder = "Search DeluluMart",
  label = "Search",
  variant = "default",
  className,
  ...props
}: SearchBarProps) {
  const [query, setQuery] = useState(defaultValue);
  const pill = variant === "pill";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(query.trim());
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on form is the requested, widely supported pattern
    <form
      role="search"
      onSubmit={submit}
      className={cn(pill ? "relative flex w-full" : "flex w-full gap-2", className)}
      {...props}
    >
      <Input
        type="search"
        name="q"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className={cn(
          "min-w-0 flex-1",
          pill && "h-12 rounded-pill border-transparent pr-14 pl-5 focus-visible:outline-fg-on-band",
        )}
      />
      <Button
        type="submit"
        aria-label={label}
        className={cn("shrink-0", pill && "absolute top-0.5 right-0.5 size-11 rounded-pill px-0")}
      >
        <Search aria-hidden="true" className="size-4" />
      </Button>
    </form>
  );
}
