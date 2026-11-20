"use client";

import * as RadixTabs from "@radix-ui/react-tabs";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type TabsProps = ComponentPropsWithRef<typeof RadixTabs.Root>;
export type TabsListProps = ComponentPropsWithRef<typeof RadixTabs.List>;
export type TabsTriggerProps = ComponentPropsWithRef<typeof RadixTabs.Trigger>;
export type TabsContentProps = ComponentPropsWithRef<typeof RadixTabs.Content>;

export function Tabs({ className, ...props }: TabsProps) {
  return <RadixTabs.Root className={cn("flex flex-col gap-3", className)} {...props} />;
}

export function TabsList({ className, ...props }: TabsListProps) {
  return (
    <RadixTabs.List
      className={cn("flex max-w-full overflow-x-auto border-b border-border", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "min-h-touch shrink-0 border-b-2 border-transparent px-4 font-body text-base font-medium text-fg-muted transition-colors duration-fast hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:border-action data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsContentProps) {
  return <RadixTabs.Content className={cn("font-body text-fg", className)} {...props} />;
}
