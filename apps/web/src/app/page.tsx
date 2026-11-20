import { formatInrCompact, STARTING_GRANT_PAISE } from "@delulu/core";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-content px-4 py-16">
      <h1 className="font-display text-4xl font-bold">DeluluMart</h1>
      <p className="mt-4 text-fg-muted">
        Start with {formatInrCompact(STARTING_GRANT_PAISE)}. Fictional money only. Nothing real ships.
      </p>
    </main>
  );
}
