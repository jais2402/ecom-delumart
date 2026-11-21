"use client";

import { rupees } from "@delulu/core";
import {
  AddressCard,
  BankChallenge,
  CartLines,
  CheckoutSteps,
  type DataColumn,
  DataTable,
  FilterPanel,
  HomeIcon,
  OrderSummary,
  PackageIcon,
  ProductCard,
  ProductGrid,
  Receipt,
  SidebarNav,
  SiteFooter,
  SiteHeader,
  StatementTable,
  StatGrid,
  type TrackingStage,
  TrackingTimeline,
  VirtualCard,
  WalletIcon,
} from "@delulu/ui";
import { useState } from "react";
import { CATEGORIES, SEED_PRODUCTS } from "../../data/seed-catalog";
import { SEED_STORE_NAME } from "../_lib/catalog";
import { PRICE_STEPS } from "../_lib/price-steps";
import { Level, Specimen } from "./Specimen";

type DemoRow = { id: string; name: string; stock: number };
const demoColumns: DataColumn<DemoRow>[] = [
  { key: "name", header: "Product", cell: (row) => row.name },
  { key: "stock", header: "In stock", cell: (row) => row.stock, align: "right" },
];
const demoRows: DemoRow[] = [
  { id: "a", name: "Teleporting Tiffin Box", stock: 12 },
  { id: "b", name: "Pocket Comet", stock: 3 },
];

const stages: TrackingStage[] = [
  { key: "placed", title: "Order placed", time: "Tue, 9:00 am", state: "done" },
  { key: "packed", title: "Packed by the seller", time: "Tue, 9:10 am", state: "done" },
  { key: "way", title: "On the way", time: "Tue, 9:30 am", state: "current", note: "Simulated courier" },
  { key: "near", title: "Nearby", state: "upcoming" },
  { key: "delivered", title: "Delivered", state: "upcoming" },
];

export function OrganismsSection() {
  const [category, setCategory] = useState<string | undefined>(CATEGORIES[0]?.slug);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [zapOnly, setZapOnly] = useState(false);
  const [lines, setLines] = useState([
    { id: "l1", name: "Teleporting Tiffin Box", hue: 20, quantity: 2, unitPricePaise: 499_900n },
    { id: "l2", name: "Pocket Comet", hue: 220, quantity: 1, unitPricePaise: 12_000_00n },
  ]);
  // the showcase uses the bundled seed file, not the live catalog
  const items = SEED_PRODUCTS.slice(0, 4).map((product) => ({
    id: product.id,
    href: `/p/${product.id}`,
    name: product.name,
    hook: product.hook,
    hue: product.templateHue,
    imageAlt: product.altText,
    pricePaise: rupees(product.priceRupees),
    storeName: SEED_STORE_NAME,
    zapEligible: product.zapEligible,
  }));
  const first = items[0];

  return (
    <Level id="organisms" title="Organisms" intro="Distinct sections of a screen. They never fetch data.">
      <Specimen title="SiteHeader">
        <div className="w-full overflow-hidden rounded-md border border-border">
          <SiteHeader balancePaise={100_000_000_000_00n} cartCount={2} onSearch={() => {}} />
        </div>
      </Specimen>
      <Specimen title="SiteFooter">
        <div className="w-full overflow-hidden rounded-md border border-border">
          <SiteFooter />
        </div>
      </Specimen>
      <Specimen title="ProductCard (default, low stock + Zap)">
        {first ? (
          <>
            <div className="w-56 max-w-full">
              <ProductCard headingLevel={4} {...first} />
            </div>
            <div className="w-56 max-w-full">
              <ProductCard headingLevel={4} {...first} stock={{ state: "low", count: 2 }} zapEligible />
            </div>
          </>
        ) : null}
      </Specimen>
      <Specimen title="ProductGrid (filled and empty)">
        <ProductGrid items={items.slice(0, 2)} label="Demo products" headingLevel={4} className="w-full" />
        <ProductGrid items={[]} emptyTitle="No products found" className="w-full" />
      </Specimen>
      <Specimen title="FilterPanel">
        <FilterPanel
          categories={CATEGORIES}
          {...(category ? { category } : {})}
          onCategoryChange={setCategory}
          priceSteps={PRICE_STEPS}
          minPrice={minPrice}
          maxPrice={maxPrice}
          onPriceChange={({ min, max }) => {
            setMinPrice(min);
            setMaxPrice(max);
          }}
          zapOnly={zapOnly}
          onZapOnlyChange={setZapOnly}
          onReset={() => {
            setCategory(undefined);
            setMinPrice("");
            setMaxPrice("");
            setZapOnly(false);
          }}
          className="w-full"
        />
      </Specimen>
      <Specimen title="CartLines (grouped by seller)">
        <CartLines
          className="w-full"
          groups={[{ sellerId: "cloud", sellerName: "Cloud Nine Gadgetry", lines }]}
          onRemove={(id) => setLines((current) => current.filter((line) => line.id !== id))}
        />
      </Specimen>
      <Specimen title="OrderSummary">
        <OrderSummary
          className="w-full"
          itemsTotalPaise={2_000_00n}
          discountPaise={200_00n}
          deliveryFeePaise={1_000_00n}
          totalPaise={2_800_00n}
        />
      </Specimen>
      <Specimen title="CheckoutSteps">
        <CheckoutSteps current={2} />
      </Specimen>
      <Specimen title="BankChallenge">
        <BankChallenge
          headingLevel={4}
          className="w-full"
          amountPaise={2_800_00n}
          cardAlias="Everyday card"
          onPay={() => {}}
          onCancel={() => {}}
        />
      </Specimen>
      <Specimen title="TrackingTimeline">
        <TrackingTimeline stages={stages} />
      </Specimen>
      <Specimen title="DataTable">
        <DataTable<DemoRow>
          caption="Stock levels"
          columns={demoColumns}
          rows={demoRows}
          rowKey={(row) => row.id}
          className="w-full"
        />
        <DataTable<DemoRow>
          caption="Empty table"
          columns={demoColumns}
          rows={[]}
          rowKey={(row) => row.id}
          emptyTitle="No stock rows"
          className="w-full"
        />
      </Specimen>
      <Specimen title="StatementTable">
        <StatementTable
          className="w-full"
          rows={[
            {
              id: "1",
              date: "12 Mar",
              description: "Welcome grant",
              amountPaise: 100_000_000_000_00n,
              balanceAfterPaise: 100_000_000_000_00n,
            },
            {
              id: "2",
              date: "13 Mar",
              description: "Teleporting Tiffin Box",
              amountPaise: -499_900n,
              balanceAfterPaise: 99_999_500_100n,
            },
          ]}
        />
      </Specimen>
      <Specimen title="VirtualCard (active and frozen)">
        <VirtualCard holderName="Asha Rao" number="4111111111111234" />
        <VirtualCard holderName="Asha Rao" number="4111111111115678" frozen alias="Frozen card" />
      </Specimen>
      <Specimen title="SidebarNav">
        <SidebarNav
          label="Demo sections"
          currentHref="/account/orders"
          className="w-full"
          items={[
            { label: "Overview", href: "/account" },
            { label: "Orders", href: "/account/orders" },
            { label: "Wallet", href: "/account/wallet" },
          ]}
        />
        <SidebarNav
          label="Demo sections with icons"
          currentHref="/account/orders"
          className="w-full"
          items={[
            { label: "Overview", href: "/account", icon: HomeIcon },
            { label: "Orders", href: "/account/orders", icon: PackageIcon },
            { label: "Wallet", href: "/account/wallet", icon: WalletIcon },
          ]}
        />
      </Specimen>
      <Specimen title="StatGrid">
        <StatGrid
          className="w-full"
          aria-label="Demo figures"
          stats={[
            { label: "Orders", value: "42", change: "+4 vs yesterday" },
            { label: "Sales", value: "₹3 crore", asOf: "As of 9:00 am" },
          ]}
        />
      </Specimen>
      <Specimen title="AddressCard">
        <AddressCard
          label="Home"
          text="Teacup Terrace, Cloud Nine Heights"
          kind="fictional"
          onEdit={() => {}}
          onDelete={() => {}}
          className="w-full"
        />
        <AddressCard
          label="Office"
          text="A real street, somewhere"
          kind="real"
          onEdit={() => {}}
          className="w-full"
        />
      </Specimen>
      <Specimen title="Receipt">
        <Receipt
          className="w-full"
          reference="DM-1042"
          placedAt="Tue, 9:00 am"
          lines={[{ id: "a", name: "Teleporting Tiffin Box", quantity: 2, totalPaise: 999_800n }]}
          itemsTotalPaise={999_800n}
          deliveryFeePaise={1_000_00n}
          totalPaise={1_099_800n}
        />
      </Specimen>
    </Level>
  );
}
