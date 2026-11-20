import { type ComponentPropsWithRef, useId } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Label } from "../../atoms/Label";
import { Select } from "../../atoms/Select";
import { Switch } from "../../atoms/Switch";
import { cn } from "../../lib/cn";

export type FilterCategory = { slug: string; name: string };
export type PriceStep = { value: string; label: string };

export type FilterPanelProps = Omit<ComponentPropsWithRef<"form">, "children" | "onChange" | "onSubmit"> & {
  /** When omitted the category list is not shown. */
  categories?: readonly FilterCategory[];
  /** Selected category slug; empty string or undefined means all. */
  category?: string;
  onCategoryChange?: (slug: string | undefined) => void;
  priceSteps: readonly PriceStep[];
  /** Value of a price step, or "" for any. */
  minPrice: string;
  maxPrice: string;
  onPriceChange: (range: { min: string; max: string }) => void;
  zapOnly: boolean;
  onZapOnlyChange: (zapOnly: boolean) => void;
  onReset?: () => void;
};

/** Fully controlled: state lives with the caller. */
export function FilterPanel({
  categories,
  category,
  onCategoryChange,
  priceSteps,
  minPrice,
  maxPrice,
  onPriceChange,
  zapOnly,
  onZapOnlyChange,
  onReset,
  className,
  ...props
}: FilterPanelProps) {
  const uid = useId();
  const minId = `${uid}-min`;
  const maxId = `${uid}-max`;
  const zapId = `${uid}-zap`;
  return (
    <form
      aria-label="Filters"
      onSubmit={(event) => event.preventDefault()}
      className={cn("flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 font-body", className)}
      {...props}
    >
      {categories ? (
        <section aria-labelledby={`${uid}-cat`} className="flex flex-col gap-1">
          <Heading level={2} size="sm" id={`${uid}-cat`}>
            Category
          </Heading>
          <ul className="flex flex-col">
            {[{ slug: "", name: "All categories" }, ...categories].map((entry) => {
              const selected = (category ?? "") === entry.slug;
              return (
                <li key={entry.slug || "all"}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onCategoryChange?.(entry.slug || undefined)}
                    className={cn(
                      "min-h-touch w-full rounded-md px-3 text-left text-base hover:bg-action-soft",
                      selected ? "bg-action-soft font-bold text-fg" : "text-fg",
                    )}
                  >
                    {entry.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-display text-xl font-bold text-fg">Price range</legend>
        <div className="flex flex-col gap-1">
          <Label htmlFor={minId}>Minimum price</Label>
          <Select
            id={minId}
            value={minPrice}
            onChange={(event) => onPriceChange({ min: event.target.value, max: maxPrice })}
          >
            <option value="">Any</option>
            {priceSteps.map((step) => (
              <option key={step.value} value={step.value}>
                {step.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={maxId}>Maximum price</Label>
          <Select
            id={maxId}
            value={maxPrice}
            onChange={(event) => onPriceChange({ min: minPrice, max: event.target.value })}
          >
            <option value="">Any</option>
            {priceSteps.map((step) => (
              <option key={step.value} value={step.value}>
                {step.label}
              </option>
            ))}
          </Select>
        </div>
      </fieldset>
      <div className="flex items-center justify-between gap-3">
        <span id={zapId} className="text-base text-fg">
          Zap available
        </span>
        <Switch aria-labelledby={zapId} checked={zapOnly} onCheckedChange={onZapOnlyChange} />
      </div>
      {onReset ? (
        <Button type="button" variant="secondary" onClick={onReset}>
          Clear filters
        </Button>
      ) : null}
    </form>
  );
}
