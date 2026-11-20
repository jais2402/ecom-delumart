import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { cn } from "../../lib/cn";

export type PaginationProps = Omit<ComponentPropsWithRef<"nav">, "children" | "onChange"> & {
  /** One-based current page. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
};

export function Pagination({ page, pageCount, onPageChange, className, ...props }: PaginationProps) {
  return (
    <nav
      aria-label="Pagination"
      className={cn("flex items-center justify-between gap-2", className)}
      {...props}
    >
      <Button
        variant="secondary"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        <span className="sr-only sm:not-sr-only">Previous</span>
      </Button>
      <p className="font-body text-sm text-fg" aria-live="polite">
        Page {page} of {pageCount}
      </p>
      <Button
        variant="secondary"
        aria-label="Next page"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        <span className="sr-only sm:not-sr-only">Next</span>
        <ChevronRight aria-hidden="true" className="size-4" />
      </Button>
    </nav>
  );
}
