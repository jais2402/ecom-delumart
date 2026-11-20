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
};

export function SearchBar({
  onSearch,
  defaultValue = "",
  placeholder = "Search DeluluMart",
  label = "Search",
  className,
  ...props
}: SearchBarProps) {
  const [query, setQuery] = useState(defaultValue);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(query.trim());
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="search" on form is the requested, widely supported pattern
    <form role="search" onSubmit={submit} className={cn("flex w-full gap-2", className)} {...props}>
      <Input
        type="search"
        name="q"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="min-w-0 flex-1"
      />
      <Button type="submit" aria-label={label} className="shrink-0">
        <Search aria-hidden="true" className="size-4" />
      </Button>
    </form>
  );
}
