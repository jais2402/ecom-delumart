import { Alert, Heading, InfoSection, PageContents, Text } from "@delulu/ui";
import { DRAFT_NOTICE_TEXT, DRAFT_NOTICE_TITLE, type PolicyDocument } from "../../_lib/legal-content";
import { ShopShell } from "../ShopShell";

/**
 * A draft policy page: the "Draft for legal review" notice first, a short contents list, then the
 * sections. The text is data (see _lib/legal-content.ts) so a reviewer can find and replace it.
 */
export function PolicyPage({ doc }: { doc: PolicyDocument }) {
  return (
    <ShopShell>
      <div className="flex flex-col gap-4 md:gap-6">
        <Alert tone="warning" title={DRAFT_NOTICE_TITLE}>
          {DRAFT_NOTICE_TEXT}
        </Alert>
        <header className="rounded-lg bg-surface p-5 md:p-6">
          <Heading level={1} size="xl">
            {doc.title}
          </Heading>
          <Text muted className="mt-1 max-w-reading">
            {doc.summary}
          </Text>
        </header>
        <PageContents items={doc.sections.map((s) => ({ label: s.title, href: `#${s.id}` }))} />
        {doc.sections.map((section) => (
          <InfoSection key={section.id} id={section.id} title={section.title}>
            {section.blocks.map((block) =>
              typeof block === "string" ? (
                <p key={block}>{block}</p>
              ) : (
                <ul key={block.list[0]}>
                  {block.list.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </InfoSection>
        ))}
        <Text size="sm" muted>
          Other policies:{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/legal/terms">
            Terms of use
          </a>
          ,{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/legal/privacy">
            Privacy notice
          </a>
          ,{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/legal/research">
            Research use
          </a>
          . How things work, in plain words:{" "}
          <a className="inline-flex min-h-touch items-center text-action underline" href="/help">
            Help centre
          </a>
          .
        </Text>
      </div>
    </ShopShell>
  );
}
