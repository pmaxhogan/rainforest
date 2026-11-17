/**
 * Invoice page parser (tool `get_invoice`): the printable order summary.
 *
 * The current print page is the order-details component shell (same `data-component` blocks,
 * `printOD` refs) without the shipment buttons, plus a Print button. It is parsed with the
 * order-details building blocks. Pieces the brief asks for that this layout does not show
 * (shipping speed, billing address, a card transactions list) are read by label anchors, so
 * the older table-style print page still yields them; those anchors are covered by synthetic
 * tests only because the corpus layout does not render them.
 */
import { RfError } from "@rainforest/core";
import type { OtherSection, Parser } from "@rainforest/core";
import { type DomElement, type Money, parseCapture, parseMoney, q, qa, text } from "../dom.ts";
import { firstOf, newMeta } from "../strategy.ts";
import { Consumption, DEFAULT_BLOCK_SELECTOR, losslessReport } from "../lossless.ts";
import {
  type ActionLabel,
  type ChargeLine,
  type DateValue,
  type ItemCtx,
  type OrderItem,
  type PaymentSummary,
  type ShipTo,
  type ShipmentStatus,
  classifyControls,
  comp,
  errorBanner,
  findDates,
  findMoneyAll,
  parseCard,
  parseOrderTypes,
  parsePayment,
  parseShipTo,
  parseShipments,
  parseTotals,
  redactDigits,
  sweepButtons,
  textLines,
} from "./order-details.ts";

export interface InvoiceShipment {
  /** Date the shipment went out / was delivered, when the page says "Shipped on ..." or the status does. */
  shipped_on?: DateValue;
  status?: ShipmentStatus;
  items: OrderItem[];
  shipping_address?: ShipTo;
  /** "Standard Shipping", "Two-Day Shipping", ... as shown. */
  shipping_speed?: string;
}

export interface InvoiceTransaction {
  /** The line as shown, card digits redacted. */
  raw: string;
  date?: DateValue;
  card_brand?: string;
  card_name?: string;
  last4?: string;
  amount?: Money;
}

export interface InvoicePayment extends PaymentSummary {
  billing_address?: ShipTo;
}

export interface Invoice {
  order_id?: string;
  placed?: DateValue;
  /** Grand total of the order. */
  order_total?: Money;
  order_types: string[];
  brand?: string;
  ship_to?: ShipTo;
  shipments: InvoiceShipment[];
  payment: InvoicePayment;
  /** Every labeled charge line, in page order. */
  charge_breakdown: ChargeLine[];
  /** Card charges listed on the page. */
  transactions: InvoiceTransaction[];
  /** Refund lines (also present in charge_breakdown). */
  refunds: ChargeLine[];
  notices: string[];
  actions: ActionLabel[];
}

const HEADING = "h1, h2, h3, h4, h5, h6, b, strong, span.a-text-bold, .a-text-bold";

function headingBlock(
  scope: DomElement,
  pattern: RegExp,
): { heading: DomElement; box: DomElement } | undefined {
  for (const h of qa(scope, HEADING)) {
    if (!pattern.test(text(h))) continue;
    const box = h.parentElement;
    if (box !== null && box !== scope) return { heading: h, box };
  }
  return undefined;
}

function shipToFromBlock(
  scope: DomElement,
  pattern: RegExp,
  used: Consumption,
): ShipTo | undefined {
  const found = headingBlock(scope, pattern);
  if (found === undefined) return undefined;
  const heading = text(found.heading);
  const lines = textLines(found.box).filter((l) => l !== heading);
  if (lines.length === 0) return undefined;
  used.take(found.box);
  const out: ShipTo = { heading, address_lines: [], lines };
  out.name = lines[0];
  let tail = lines.slice(1);
  const last = tail[tail.length - 1];
  if (last !== undefined && tail.length >= 2 && !/\d/.test(last)) {
    out.country = last;
    tail = tail.slice(0, -1);
  }
  out.address_lines = tail;
  return out;
}

function parseTransactions(scope: DomElement, used: Consumption): InvoiceTransaction[] {
  const found = headingBlock(scope, /transactions\b/i);
  if (found === undefined) return [];
  const heading = text(found.heading);
  const out: InvoiceTransaction[] = [];
  for (const line of textLines(found.box)) {
    if (line === heading) continue;
    const safe = redactDigits(line);
    const amounts = findMoneyAll(safe);
    const amount = amounts.length > 0 ? parseMoney(amounts[amounts.length - 1]?.raw) : undefined;
    const date = findDates(safe)[0];
    const card = parseCard(safe);
    if (amount === undefined && date === undefined && card.last4 === undefined) continue;
    const tx: InvoiceTransaction = { raw: safe, ...card };
    if (date !== undefined) tx.date = date;
    if (amount !== undefined) tx.amount = amount;
    out.push(tx);
  }
  used.take(found.box);
  return out;
}

/** Value of "Label: value" on the same line, or on the next line when the label stands alone. */
function labeled(lines: readonly string[], label: RegExp): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = new RegExp(`^(?:${label.source})\\s*:?\\s*(.*)$`, label.flags).exec(line);
    if (m === null) continue;
    const same = (m[1] ?? "").trim();
    if (same !== "") return same;
    const next = lines[i + 1];
    if (next !== undefined && !/:\s*$/.test(next)) return next;
  }
  return undefined;
}

export const parseInvoice: Parser<Invoice> = (capture) => {
  const meta = newMeta();
  const used = new Consumption();
  const { doc } = parseCapture(capture);
  const main = q(doc, "[role=main]") ?? q(doc, "#orderDetails") ?? doc.body;
  const scope = q(main, "#orderDetails") ?? main;

  const banner = errorBanner(scope);
  const hasContent =
    comp(scope, "shipments") !== undefined ||
    comp(scope, "orderSummary") !== undefined ||
    comp(scope, "chargeSummary") !== undefined;
  if (banner !== undefined && !hasContent) {
    throw new RfError("layout_unrecognized", "invoice page shows an error banner", {
      details: { reason: "error_banner", heading: banner.heading },
    });
  }

  const order_id = firstOf<string>(
    "order_id",
    [
      [
        "data-component",
        () => /\b([A-Z0-9]{3}-\d{7}-\d{7})\b/.exec(text(comp(scope, "orderId")))?.[1],
      ],
      [
        "text-anchor",
        () =>
          /Order\s*(?:#|number|no\.?|ID)\s*:?\s*([A-Z0-9]{3}-\d{7}-\d{7})/i.exec(text(scope))?.[1],
      ],
      ["url", () => /[?&]order(?:id|Id|ID)=([A-Z0-9]{3}-\d{7}-\d{7})/.exec(capture.final_url)?.[1]],
    ],
    meta,
  );
  used.take(comp(scope, "orderId"));
  used.take(comp(scope, "orderIdLabel"));

  const placedEl = comp(scope, "orderDate");
  const placed = firstOf<DateValue>(
    "placed",
    [
      ["data-component", () => findDates(text(placedEl))[0]],
      [
        "text-anchor",
        () => {
          const m = /Order\s+placed:?\s*(.{0,40})/i.exec(text(scope));
          return m?.[1] === undefined ? undefined : findDates(m[1])[0];
        },
      ],
    ],
    meta,
  );
  used.take(placedEl);
  used.take(comp(scope, "orderDateLabel"));
  const ctx: ItemCtx = placed?.iso === undefined ? {} : { placedIso: placed.iso };

  used.take(comp(scope, "breadcrumb"));
  used.take(comp(scope, "orderDetailsTitle"));
  used.take(comp(scope, "printODTitle"));

  const ship_to = parseShipTo(scope, used, meta);
  const payment: InvoicePayment = parsePayment(scope, used, meta);
  const charge_breakdown = parseTotals(scope, used, meta);
  const base = parseShipments(scope, used, meta, ctx);

  const billing = shipToFromBlock(scope, /^billing address/i, used);
  if (billing !== undefined) payment.billing_address = billing;
  const transactions = parseTransactions(scope, used);

  const lines = textLines(scope);
  const speed = labeled(lines, /shipping speed|delivery speed|shipping method/i);
  const shippedLines = lines
    .map((l) => /^shipped on:?\s*(.*)$/i.exec(l)?.[1])
    .filter((v): v is string => v !== undefined);

  const shipments: InvoiceShipment[] = base.map((s, i) => {
    const out: InvoiceShipment = { items: s.items };
    if (s.status !== undefined) out.status = s.status;
    const fromStatus =
      s.status !== undefined && (s.status.kind === "delivered" || s.status.kind === "shipped")
        ? s.status.date
        : undefined;
    const fromLine = findDates(shippedLines[i] ?? "", ctx.placedIso)[0];
    const shipped = fromLine ?? fromStatus;
    if (shipped !== undefined) out.shipped_on = shipped;
    if (ship_to !== undefined) out.shipping_address = ship_to;
    if (speed !== undefined) out.shipping_speed = speed;
    return out;
  });

  const { types, brand } = parseOrderTypes(scope, order_id, base, used);
  const swept = sweepButtons(scope, used);
  const actions: ActionLabel[] = [
    ...swept.actions,
    ...classifyControls(comp(scope, "orderInvoice"), used).actions,
  ];
  const notices: string[] = [];
  for (const name of [
    "alerts",
    "debugBanner",
    "aapiDebug",
    "poNumber",
    "sharedOrderBuyer",
    "cancelled",
  ]) {
    const el = comp(scope, name);
    const t = text(el);
    if (t !== "") notices.push(t);
    used.take(el);
  }

  const totalLine = charge_breakdown.find((l) => l.type === "grand_total");
  const order_total = firstOf<Money>(
    "order_total",
    [
      ["charge-line", () => totalLine?.amount],
      [
        "text-anchor",
        () => {
          const m = /Order Total:?\s*(\S+)/i.exec(text(scope));
          return parseMoney(m?.[1]);
        },
      ],
    ],
    meta,
    { optional: true },
  );

  const data: Invoice = {
    order_types: types,
    shipments,
    payment,
    charge_breakdown,
    transactions,
    refunds: charge_breakdown.filter((l) => l.type === "refund" || l.type === "refund_total"),
    notices,
    actions,
  };
  if (order_id !== undefined) data.order_id = order_id;
  if (placed !== undefined) data.placed = placed;
  if (order_total !== undefined) data.order_total = order_total;
  if (brand !== undefined) data.brand = brand;
  if (ship_to !== undefined) data.ship_to = ship_to;

  if (order_id === undefined && shipments.length === 0 && charge_breakdown.length === 0) {
    throw new RfError("layout_unrecognized", "invoice page has no recognizable content");
  }

  const report = losslessReport(doc, used, {
    root: main,
    blockSelector: `${DEFAULT_BLOCK_SELECTOR}, [data-component]`,
  });
  meta.unparsed_text_chars = report.counts.unparsed;
  const other_sections: OtherSection[] = report.sections;
  return { data, other_sections, meta };
};
