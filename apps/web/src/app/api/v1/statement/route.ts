import { myStatement } from "@delulu/db/runtime";
import { webPool } from "@/server/db";
import { route } from "@/server/http";
import { bigintPageQuery } from "@/server/query";
import { statementRowView } from "@/server/views";

/** GET /api/v1/statement?cursor=&limit=: own postings, newest first. */
export const GET = route({ auth: "session", query: bigintPageQuery }, async ({ session, query }) => {
  const page = await myStatement(webPool(), {
    authSessionId: session.id,
    cursor: query.cursor ?? null,
    ...(query.limit === undefined ? {} : { pageSize: query.limit }),
  });
  return {
    json: {
      items: page.items.map(statementRowView),
      nextCursor: page.nextCursor === null ? null : page.nextCursor.toString(),
    },
  };
});
