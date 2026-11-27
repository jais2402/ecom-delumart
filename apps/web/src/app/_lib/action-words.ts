import { type AdminActionItem, actionSentence } from "./admin-actions";
import { methodChangeSentence } from "./payment-methods-admin";

const PAYMENT_KEY = /^payment_method\.([A-Z_]{1,20})$/;

/** What a queued action will do, in words: a configuration change or a payment method change. */
export function actionWords(a: Pick<AdminActionItem, "kind" | "key" | "value" | "details">): string {
  if (a.kind === "payment_method.set") {
    const method = a.key === null ? null : PAYMENT_KEY.exec(a.key)?.[1];
    return method ? methodChangeSentence(method, a.details) : "Unknown action";
  }
  return actionSentence(a);
}
