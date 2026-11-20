import { Heading, Text } from "@delulu/ui";

const templates = [
  { name: "ShopLayout", slots: "header, main, footer. Adds a skip-to-content link." },
  {
    name: "AccountLayout",
    slots: "ShopLayout plus a sidebar that stacks above the content on small screens.",
  },
  {
    name: "CheckoutLayout",
    slots: "steps on top; main content and an order summary aside that stacks on mobile.",
  },
  { name: "PortalLayout", slots: "Partner Portal: sidebar navigation, top bar and main." },
  { name: "ConsoleLayout", slots: "Commerce Console: sidebar navigation, top bar and main." },
  { name: "BankPageLayout", slots: "a centred narrow panel, labelled as an in-game bank page." },
] as const;

/** Templates hold slots and no content, so they are described here rather than rendered as full pages. */
export function TemplatesSection() {
  return (
    <section aria-labelledby="templates" className="flex flex-col gap-4">
      <div>
        <Heading level={2} size="lg" id="templates">
          Templates
        </Heading>
        <Text muted className="max-w-reading">
          Page layouts with slots. This page itself uses ShopLayout.
        </Text>
      </div>
      <ul className="grid gap-3 md:grid-cols-2">
        {templates.map((template) => (
          <li key={template.name} className="rounded-lg border border-border bg-surface p-4">
            <Heading level={3} size="sm">
              {template.name}
            </Heading>
            <Text size="sm" muted>
              {template.slots}
            </Text>
          </li>
        ))}
      </ul>
    </section>
  );
}
