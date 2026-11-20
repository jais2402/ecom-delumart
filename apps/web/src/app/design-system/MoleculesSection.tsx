"use client";

import {
  Alert,
  BalancePill,
  Breadcrumbs,
  Button,
  CardNumber,
  CouponInput,
  DeliveryOption,
  Dialog,
  EmptyState,
  FormField,
  Input,
  Pagination,
  PaymentMethodOption,
  PinField,
  PriceBlock,
  SearchBar,
  SourceBadge,
  Stat,
  StepIndicator,
  StockBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TimelineItem,
} from "@delulu/ui";
import { useState } from "react";
import { Level, Specimen } from "./Specimen";

export function MoleculesSection() {
  const [page, setPage] = useState(2);
  const [coupon, setCoupon] = useState<string | undefined>();
  return (
    <Level id="molecules" title="Molecules" intro="Small groups of atoms with one job.">
      <Specimen title="FormField">
        <FormField label="Display name" hint="Shown on reviews" required>
          {(control) => <Input {...control} />}
        </FormField>
        <FormField label="Gift note" error="Keep it under 100 characters">
          {(control) => <Input {...control} defaultValue="too long" />}
        </FormField>
      </Specimen>
      <Specimen title="SearchBar">
        <SearchBar onSearch={() => {}} />
      </Specimen>
      <Specimen title="PriceBlock and BalancePill">
        <PriceBlock amountPaise={499_900n} />
        <PriceBlock amountPaise={399_900n} referenceAmountPaise={499_900n} saleLabel="Sale" display="exact" />
        <BalancePill balancePaise={100_000_000_000_00n} className="max-w-full flex-wrap" />
      </Specimen>
      <Specimen title="StockBadge">
        <StockBadge state="in-stock" />
        <StockBadge state="low" count={3} />
        <StockBadge state="sold-out" />
        <StockBadge state="edition" number={7} of={100} />
      </Specimen>
      <Specimen title="SourceBadge">
        <SourceBadge source="player" />
        <SourceBadge source="npc" />
        <SourceBadge source="staff" />
      </Specimen>
      <Specimen title="DeliveryOption">
        <div className="flex w-full flex-col gap-2">
          <DeliveryOption
            name="ds-delivery"
            speedName="Standard"
            arrival="Arrives in 24 hours"
            feePaise={1_000_00n}
            defaultChecked
          />
          <DeliveryOption
            name="ds-delivery"
            speedName="Express"
            arrival="Arrives in 2 hours"
            feePaise={10_000_00n}
          />
          <DeliveryOption
            name="ds-delivery"
            speedName="Pickup"
            arrival="From a fictional locker"
            feePaise={0n}
            disabled
          />
        </div>
      </Specimen>
      <Specimen title="PaymentMethodOption">
        <div className="flex w-full flex-col gap-2">
          <PaymentMethodOption
            name="ds-pay"
            methodName="Delulu Bank virtual card"
            description="Everyday card"
            defaultChecked
          />
          <PaymentMethodOption
            name="ds-pay"
            methodName="Wallet"
            disabledReason="Not enough fictional money"
          />
        </div>
      </Specimen>
      <Specimen title="CouponInput">
        <CouponInput
          onApply={setCoupon}
          onRemove={() => setCoupon(undefined)}
          {...(coupon ? { appliedCode: coupon } : {})}
          className="w-full"
        />
      </Specimen>
      <Specimen title="PinField and CardNumber">
        <PinField />
        <CardNumber number="4111111111111234" />
      </Specimen>
      <Specimen title="Alert">
        <div className="flex w-full flex-col gap-2">
          <Alert tone="info" title="Heads up">
            Delivery is simulated.
          </Alert>
          <Alert tone="success" title="Order placed" />
          <Alert tone="warning" title="Low balance" />
          <Alert tone="danger" title="Payment declined">
            Try another card.
          </Alert>
        </div>
      </Specimen>
      <Specimen title="EmptyState">
        <EmptyState
          title="No orders yet"
          description="Your first impossible purchase will show up here."
          headingLevel={4}
          className="w-full"
        />
      </Specimen>
      <Specimen title="Stat">
        <Stat label="Orders today" value="42" change="+4 vs yesterday" asOf="As of 9:00 am" />
      </Specimen>
      <Specimen title="StepIndicator and TimelineItem">
        <StepIndicator steps={["Delivery", "Speed", "Payment", "Review"]} current={1} />
        <ol className="w-full">
          <TimelineItem title="Order placed" time="Tue, 9:00 am" state="done" />
          <TimelineItem title="On the way" time="Tue, 9:30 am" state="current" />
          <TimelineItem title="Delivered" state="upcoming" />
        </ol>
      </Specimen>
      <Specimen title="Breadcrumbs and Pagination">
        <Breadcrumbs
          items={[
            { label: "Home", href: "/" },
            { label: "Impossible Tech", href: "/c/impossible-tech" },
            { label: "Item" },
          ]}
        />
        <Pagination page={page} pageCount={5} onPageChange={setPage} className="w-full" />
      </Specimen>
      <Specimen title="Tabs and Dialog">
        <Tabs defaultValue="one" className="w-full">
          <TabsList aria-label="Demo tabs">
            <TabsTrigger value="one">Details</TabsTrigger>
            <TabsTrigger value="two">Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="one">Details panel</TabsContent>
          <TabsContent value="two">Reviews panel</TabsContent>
        </Tabs>
        <Dialog
          title="Confirm demo"
          description="Dialogs trap focus and restore it on close."
          trigger={<Button variant="secondary">Open dialog</Button>}
        >
          <p className="mt-2 text-base">Nothing here is real.</p>
        </Dialog>
      </Specimen>
    </Level>
  );
}
