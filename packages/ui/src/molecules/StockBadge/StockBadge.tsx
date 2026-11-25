import type { ComponentPropsWithRef } from "react";
import { Badge } from "../../atoms/Badge";

export type StockState =
  | { state: "in-stock" }
  | { state: "low"; count: number }
  | { state: "sold-out" }
  | { state: "edition"; number: number; of: number };

export type StockBadgeProps = Omit<ComponentPropsWithRef<"span">, "children"> & StockState;

export function StockBadge(props: StockBadgeProps) {
  const { className } = props;
  switch (props.state) {
    case "in-stock":
      return (
        <Badge tone="success" className={className}>
          In stock
        </Badge>
      );
    case "low":
      return (
        <Badge tone="warning" className={className}>
          Only {props.count} left
        </Badge>
      );
    case "sold-out":
      return (
        <Badge tone="danger" className={className}>
          Sold out
        </Badge>
      );
    case "edition":
      return (
        <Badge tone="accent" className={className}>
          #{props.number} of {props.of}
        </Badge>
      );
  }
}
