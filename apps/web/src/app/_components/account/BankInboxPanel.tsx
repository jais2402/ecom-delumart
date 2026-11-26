"use client";

import { Text } from "@delulu/ui";
import { PAYMENT_UI_CONFIG } from "../../_lib/payments-config";
import { PageHeading } from "../PageHeading";
import { BankInbox, useBankInbox } from "../payments/BankInbox";

/**
 * Account -> Bank inbox: the Delulu Bank messages of the signed-in player. The one-time codes of net
 * banking appear here and nowhere else (PRD R4.4): no text, email or push message ever carries one.
 * Approval requests are answered on the checkout page.
 */
export function BankInboxPanel() {
  const inbox = useBankInbox(true, PAYMENT_UI_CONFIG.accountInboxPollMs);
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Bank inbox</PageHeading>
      <Text muted>
        Delulu Bank is part of the game. Its messages stay in the app and never reach your phone or email.
      </Text>
      <BankInbox messages={inbox.messages} error={inbox.error} headingLevel={2} />
    </div>
  );
}
