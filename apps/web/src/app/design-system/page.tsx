import { Divider, Heading, Text } from "@delulu/ui";
import type { Metadata } from "next";
import { ShopShell } from "../_components/ShopShell";
import { AtomsSection } from "./AtomsSection";
import { MoleculesSection } from "./MoleculesSection";
import { OrganismsSection } from "./OrganismsSection";
import { TemplatesSection } from "./TemplatesSection";

export const metadata: Metadata = { title: "Daydream design system" };

export default function DesignSystemPage() {
  return (
    <ShopShell>
      <Heading level={1} size="xl">
        Daydream design system
      </Heading>
      <Text muted className="mb-4 max-w-reading">
        Every component in its main states. Toggle your system theme to check light and dark.
      </Text>
      <nav aria-label="On this page" className="mb-6">
        <ul className="flex flex-wrap gap-x-4">
          {["atoms", "molecules", "organisms", "templates"].map((id) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="inline-flex min-h-touch items-center text-action underline underline-offset-2"
              >
                {id[0]?.toUpperCase()}
                {id.slice(1)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <AtomsSection />
      <Divider className="my-10" />
      <MoleculesSection />
      <Divider className="my-10" />
      <OrganismsSection />
      <Divider className="my-10" />
      <TemplatesSection />
    </ShopShell>
  );
}
