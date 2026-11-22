import type { Metadata } from "next";
import { ConfirmScreen } from "./ConfirmScreen";

export const metadata: Metadata = { title: "Finish signing in", referrer: "no-referrer" };

/**
 * Where the emailed sign-in link leads (ninth review, minor 6c). Opening it (a GET, which a mail
 * scanner may do) redeems nothing: the page only offers a button, and the server redeems the link
 * on the POST that button makes. The link's parameters are read here and checked again by the
 * server; nothing is fetched on the server for this GET.
 */
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : null);

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tokenHash = one(params.token_hash);
  const type = one(params.type);
  const code = one(params.code);
  const link =
    tokenHash !== null &&
    type !== null &&
    /^(pkce_)?[0-9a-f]{40,128}$/.test(tokenHash) &&
    /^(email|magiclink|signup)$/.test(type)
      ? { tokenHash, type }
      : code !== null && /^[A-Za-z0-9_-]{8,512}$/.test(code)
        ? { code }
        : null;
  return <ConfirmScreen link={link} />;
}
