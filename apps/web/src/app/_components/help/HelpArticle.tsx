import {
  CHALLENGE_RULES,
  DECLINE_REASONS,
  DEFAULT_PIN_ATTEMPT_CONFIG,
  DEFAULT_PRICING_CONFIG,
  formatInrCompact,
  formatInrExact,
  METHOD_LABELS,
  minPriceForFreeDelivery,
  REFERENCE_PRICE_RULES,
  REVIEW_RULES,
  STARTING_GRANT_PAISE,
} from "@delulu/core";
import { Alert, InfoSection, PageContents } from "@delulu/ui";
import { arrivalPhrase, SPEED_COPY } from "../../_lib/speeds";

/** The failure codes the help page explains, in the order a shopper is most likely to meet them. */
const DECLINES = [
  "INSUFFICIENT_FUNDS",
  "CHALLENGE_FAILED",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_LOCKED",
  "PIN_LOCKED",
  "CARD_FROZEN",
  "CARD_REPLACED",
  "CANCELLED",
  "METHOD_UNAVAILABLE",
  "METHOD_LIMIT_EXCEEDED",
  "BANK_UNAVAILABLE",
  "CHECKOUT_EXPIRED",
  "CART_CHANGED",
  "PRICE_CHANGED",
  "SOLD_OUT",
  "ALREADY_OWNED",
] as const;

const SPEEDS = ["STANDARD", "EXPRESS", "ZAP"] as const;

const CONTENTS = [
  { label: "How DeluluMart works", href: "#how-it-works" },
  { label: "Buying and paying", href: "#buying" },
  { label: "Delivery and tracking", href: "#delivery" },
  { label: "Selling on DeluluMart", href: "#selling" },
  { label: "Reviews", href: "#reviews" },
  { label: "Your account and privacy", href: "#account" },
] as const;

/**
 * The help centre text. Every number comes from the same defaults the app runs on (the starting
 * grant, delivery times, pricing, PIN and code rules, review limits), so the page cannot drift from
 * what the app does. Where a value can be changed by the platform owner it is said to be the usual one.
 */
export function HelpArticle() {
  const standardFee = DEFAULT_PRICING_CONFIG.deliveryFeePaise.STANDARD;
  const freeDeliveryMinimum = minPriceForFreeDelivery(DEFAULT_PRICING_CONFIG);
  const codeMinutes = CHALLENGE_RULES.ttlSeconds / 60;
  const pinLockMinutes = DEFAULT_PIN_ATTEMPT_CONFIG.lockMs / 60_000;

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <PageContents items={CONTENTS} />

      <InfoSection id="how-it-works" title="How DeluluMart works">
        <p>
          DeluluMart is a pretend store. It works like an online marketplace, but the money in it is fictional
          and nothing real is ever sold or shipped.
        </p>
        <ul>
          <li>
            <strong>Fictional money.</strong> Every account starts with{" "}
            {formatInrCompact(STARTING_GRANT_PAISE)} of fictional rupees, held in a Delulu Bank account. It
            cannot be bought, cashed out, gifted or sent to anyone, and it has no value outside the game.
          </li>
          <li>
            <strong>Nothing real ships.</strong> The products are impossible objects. When you buy one, a
            simulated delivery runs and the item then shows in your collection. No parcel, address lookup or
            courier is involved.
          </li>
          <li>
            <strong>One of each.</strong> You can own a product once. A product you already own cannot be
            added to the cart again.
          </li>
          <li>
            <strong>Three delivery speeds.</strong> You choose one for each seller at checkout. The times
            below are the simulated ones the app uses.
          </li>
        </ul>
        <ul aria-label="Delivery speeds">
          {SPEEDS.map((speed) => (
            <li key={speed}>
              <strong>{SPEED_COPY[speed].name}:</strong> arrives in {arrivalPhrase(speed)}.
              {speed === "ZAP" ? " Zap is offered on eligible products only." : ""}
            </li>
          ))}
        </ul>
        <p>
          Prices and totals are always shown before you pay, and you confirm each payment yourself. A price in
          your cart is a convenience, not a promise: it is checked again when you pay.
        </p>
      </InfoSection>

      <InfoSection id="buying" title="Buying and paying">
        <h3>Payment methods</h3>
        <p>
          Checkout offers the methods that are available at that moment: {METHOD_LABELS.BALANCE},{" "}
          {METHOD_LABELS.CARD}, {METHOD_LABELS.NET_BANKING} and {METHOD_LABELS.DELULUPAY_ID}. A method can be
          switched off for a while or have a limit per payment or per day; checkout says so instead of letting
          you fail at the end. Your attempts, successful or not, are listed under{" "}
          <a href="/account/payments">Payments</a> in your account.
        </p>
        <h3>Your PIN</h3>
        <p>
          The {METHOD_LABELS.CARD} is confirmed with a six-digit game PIN that you choose when you set up your
          account. Use a PIN only for this game: never the PIN of a real card or payment app.{" "}
          {DEFAULT_PIN_ATTEMPT_CONFIG.maxConsecutiveFailures} wrong PINs in a row lock card payments for{" "}
          {pinLockMinutes} minutes; other methods keep working. You can manage your card on the{" "}
          <a href="/account/cards">Cards</a> page.
        </p>
        <h3>Bank inbox codes</h3>
        <p>
          {METHOD_LABELS.NET_BANKING} asks for a one-time code, and a {METHOD_LABELS.DELULUPAY_ID} payment
          sends an approval request. Both arrive in your <a href="/account/bank-inbox">Bank inbox</a> inside
          the app, never by text, email or notification. A code has {CHALLENGE_RULES.codeLength} digits, lasts{" "}
          {codeMinutes} minutes, works once and allows {CHALLENGE_RULES.tries} wrong tries for that payment.
          You can ask for a new one after {CHALLENGE_RULES.resendSeconds} seconds.
        </p>
        <Alert tone="info" title="Never type real payment details">
          No field on DeluluMart accepts a real card number, expiry date, CVV, UPI PIN or bank password.
          Checkout refuses text that looks like one. Your Delulu Card number is shown, never typed.
        </Alert>
        <h3>When a payment does not go through</h3>
        <p>Each reason is shown in plain words, and every one means that no fictional money moved.</p>
        <dl className="flex flex-col gap-2">
          {DECLINES.map((code) => {
            const reason = DECLINE_REASONS[code];
            if (!reason) return null;
            return (
              <div key={code}>
                <dt className="font-bold">{reason.title}</dt>
                <dd className="text-fg-muted">{reason.message}</dd>
              </div>
            );
          })}
        </dl>
        <h3>Coupons</h3>
        <p>
          Enter a coupon code in your cart. Its terms (percentage or amount off, a minimum spend, dates, a
          limit on uses) are shown with it. Public coupons are listed on shop pages and on the{" "}
          <a href="/deals">Deals</a> page.
        </p>
      </InfoSection>

      <InfoSection id="delivery" title="Delivery and tracking">
        <ul>
          <li>
            Each seller in your order gets its own shipment. You pick Standard, Express or Zap for each at
            checkout.
          </li>
          <li>
            Delivery is a simulation with fixed stages: placed, packed, shipped, out for delivery, delivered.
            It always completes. Nothing fails at random, and you cannot pay to speed an order up after
            placing it.
          </li>
          <li>
            Follow every shipment under <a href="/account/orders">Orders</a>. When it is delivered the item
            appears in your <a href="/account/collection">collection</a>.
          </li>
          <li>
            Standard delivery usually costs {formatInrExact(standardFee)} per seller, and some sellers offer
            it free on their products. The fee is shown before you pay.
          </li>
          <li>
            A delivery address is optional. You can save a real address, or pick a fictional delivery spot
            from a list. Either way nothing is delivered there.
          </li>
        </ul>
      </InfoSection>

      <InfoSection id="selling" title="Selling on DeluluMart">
        <h3>Creator access and shops</h3>
        <p>
          Anyone can unlock <a href="/sell">creator access</a> by one of two routes: spend your balance down
          below ₹1 crore, or earn the Inventor Passport (a short quiz, saving three products and writing a
          private concept). You then register a shop with a one-time setup fee of fictional money, choose its
          handle and name, and open the Studio.
        </p>
        <h3>Listings</h3>
        <p>
          You write a listing in the Studio. Its text is checked automatically and some listings are looked at
          by a person; the editor shows where yours stands. Only published listings appear in the store. If a
          listing is turned down or hidden, you can send an appeal from the Studio.
        </p>
        <h3>Coupons</h3>
        <p>
          You can create coupons for your shop: a percentage or an amount off, with an optional minimum spend,
          start and end dates and a limit on uses. A coupon can be public, so it is listed on your shop page
          and on Deals, or kept as a code you share yourself. The discount comes out of your proceeds.
        </p>
        <h3>Sale prices and the &quot;Was&quot; price</h3>
        <p>
          You can put a published listing on sale at a lower price and end the sale whenever you like. While a
          sale runs, the list price cannot be edited.
        </p>
        <p>
          A struck-through &quot;Was&quot; price is shown only when it is honest: it is the lowest price the
          listing was published at in the last {REFERENCE_PRICE_RULES.lookbackDays} days, the listing has been
          published for at least {REFERENCE_PRICE_RULES.minHours} hours in that time, and that price is higher
          than today&apos;s. Otherwise only the current price is shown. The Studio tells you in advance
          whether a sale price will show a &quot;Was&quot; price.
        </p>
        <h3>Free delivery</h3>
        <p>
          You can offer free Standard delivery on a product; you then pay the delivery fee out of your
          proceeds. That only works when the price is high enough to cover it. With the usual{" "}
          {DEFAULT_PRICING_CONFIG.feePercent}% marketplace fee and a {formatInrExact(standardFee)} Standard
          fee
          {freeDeliveryMinimum === null
            ? " no price can cover it"
            : `, the minimum price is ${formatInrExact(freeDeliveryMinimum)}`}
          . The Studio shows the exact minimum for your shop, and refuses a price that is too low.
        </p>
      </InfoSection>

      <InfoSection id="reviews" title="Reviews">
        <ul>
          <li>
            Only a person who owns a product can review it, once, and never the owner of the selling shop.
          </li>
          <li>
            A review is a rating from {REVIEW_RULES.rating.min} to {REVIEW_RULES.rating.max}, with an optional
            title (up to {REVIEW_RULES.titleMaxChars} characters) and text (up to {REVIEW_RULES.bodyMaxChars}
            ). You can edit or delete your review later; an edited review shows &quot;Edited&quot;.
          </li>
          <li>
            Reviews are screened. One that is refused says which part to change, and no review is posted with
            links, brand-like text or shouting.
          </li>
          <li>
            A new review is visible to others from the next day. You see it straight away, marked
            &quot;Visible to others from tomorrow&quot;. Public reviews show the day, not the time, so a
            review cannot be matched to an order.
          </li>
          <li>Reviews show your public handle if you set one, plus a &quot;Verified owner&quot; badge.</li>
          <li>
            The marketplace administrator can hide a review that breaks the rules, with a recorded reason, and
            can restore it. A hidden review leaves the list and the average; its author still sees it, with
            the reason.
          </li>
        </ul>
      </InfoSection>

      <InfoSection id="account" title="Your account and privacy">
        <ul>
          <li>
            <strong>Addresses are private.</strong> A saved address is stored encrypted and only you can see
            it. Sellers never see your address, or any location, for an order. You can keep up to five and
            delete any of them; deleting one removes it from past orders too.
          </li>
          <li>
            <strong>Your choices.</strong> On your <a href="/account/profile">Profile</a> you decide whether
            your collection is on a public shelf, whether your collector level shows and whether sellers see
            your handle on orders.
          </li>
          <li>
            <strong>Research.</strong> Play is analysed in de-identified form for research and product
            experiments. If you do not want your play included, switch on &quot;Opt out of research about how
            people play&quot; on your <a href="/account/profile">Profile</a>. Playing is unaffected.
          </li>
          <li>
            <strong>Reporting.</strong> Use the Report button on a product page or a shop page to tell us
            about something that breaks the rules. You get a case reference, and your cases are listed under{" "}
            <a href="/account/reports">Reports</a>. You can block a shop from its page; blocked shops are
            listed under <a href="/account/blocks">Blocked shops</a>.
          </li>
          <li>
            <strong>Policies.</strong> The terms, privacy notice and research notice are drafts that are not
            yet in force: <a href="/legal/terms">Terms of use</a>, <a href="/legal/privacy">Privacy notice</a>{" "}
            and <a href="/legal/research">Research use</a>.
          </li>
        </ul>
      </InfoSection>
    </div>
  );
}
