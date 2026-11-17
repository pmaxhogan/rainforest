import { findOffer, product, type Offer, type Product } from "./catalog.ts";
import { code, rng, uuid } from "./util.ts";

/**
 * Server-side state of the fake storefront: one shopping session per cookie, plus the
 * request log and the trap log. Every fresh session starts from the same state derived
 * from the seed, so a test that resets the site always sees identical ids.
 */

export interface CartLine {
  itemId: string;
  asin: string;
  olid: string;
  quantity: number;
  /** Added as a Subscribe & Save subscription. */
  subscribe: boolean;
  /** A notice shown on the line (for example a quantity limit). */
  notice?: string;
}

export type Privacy = "private" | "shared" | "public";
export type Priority = "lowest" | "low" | "medium" | "high" | "highest";
export const PRIORITIES: readonly Priority[] = ["lowest", "low", "medium", "high", "highest"];

export interface ListItem {
  itemId: string;
  asin: string;
  added: string;
  comment: string;
  requested: number;
  has: number;
  priority: Priority;
}

export interface WishList {
  id: string;
  name: string;
  privacy: Privacy;
  isDefault: boolean;
  items: ListItem[];
}

export interface Session {
  id: string;
  active: CartLine[];
  saved: CartLine[];
  lists: WishList[];
  clippedCoupons: string[];
  random: () => number;
}

export interface Hit {
  seq: number;
  at: number;
  method: string;
  path: string;
  search: string;
  session: string | null;
}

export type TrapName =
  "checkout" | "proceed_to_checkout" | "buy_now" | "sign_in" | "checkpoint" | "captcha";

export interface TrapHit {
  trap: TrapName;
  method: string;
  path: string;
  at: number;
}

export interface MutationResult {
  ok: boolean;
  message: string;
  /** Extra HTML the page shows after the change (the protection plan offer). */
  upsell?: string;
}

const ADDED = "November 1, 2026";

export class Store {
  readonly seed: number;
  readonly sessions = new Map<string, Session>();
  readonly hits: Hit[] = [];
  readonly traps: TrapHit[] = [];
  #sessionCounter = 0;
  #seq = 0;
  #lastSession: string | null = null;

  constructor(seed: number) {
    this.seed = seed;
  }

  reset(): void {
    this.sessions.clear();
    this.hits.length = 0;
    this.traps.length = 0;
    this.#sessionCounter = 0;
    this.#seq = 0;
    this.#lastSession = null;
  }

  /** A new session id (deterministic sequence). */
  newSessionId(): string {
    this.#sessionCounter++;
    return `mock-${String(this.#sessionCounter).padStart(4, "0")}`;
  }

  /** The session for this id, created from the seed if unknown (also after a reset). */
  session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = initialSession(id, this.seed);
      this.sessions.set(id, s);
    }
    this.#lastSession = id;
    return s;
  }

  get lastSessionId(): string | null {
    return this.#lastSession;
  }

  record(method: string, path: string, search: string, session: string | null, at: number): void {
    this.hits.push({ seq: ++this.#seq, at, method, path, search, session });
    if (this.hits.length > 5000) this.hits.shift();
  }

  trap(trap: TrapName, method: string, path: string, at: number): void {
    this.traps.push({ trap, method, path, at });
  }

  trapCount(trap?: TrapName): number {
    return trap ? this.traps.filter((t) => t.trap === trap).length : this.traps.length;
  }
}

export function initialSession(id: string, seed: number): Session {
  const random = rng(seed);
  const line = (asin: string, quantity: number): CartLine => ({
    itemId: uuid(random),
    asin,
    olid: product(asin)!.featured!.olid,
    quantity,
    subscribe: false,
  });
  const item = (asin: string, extra: Partial<ListItem> = {}): ListItem => ({
    itemId: code(random, "I", 14),
    asin,
    added: ADDED,
    comment: "",
    requested: 1,
    has: 0,
    priority: "medium",
    ...extra,
  });
  const active = [line("B0FAKE0001", 1), line("B0FAKE0003", 2)];
  const saved = [line("B0FAKE0008", 1)];
  const lists: WishList[] = [
    {
      id: code(random, "1", 13),
      name: "Shopping List",
      privacy: "private",
      isDefault: true,
      items: [item("B0FAKE0002"), item("B0FAKE0006", { comment: "Compare scanners first" })],
    },
    {
      id: code(random, "2", 13),
      name: "Gift Ideas",
      privacy: "shared",
      isDefault: false,
      items: [item("B0FAKE000B", { requested: 2, priority: "high" })],
    },
  ];
  return { id, active, saved, lists, clippedCoupons: [], random };
}

/** Price of a cart line in cents, after a clipped coupon and the subscription discount. */
export function linePrice(session: Session, line: CartLine): number {
  const found = findOffer(line.olid);
  const p = product(line.asin);
  let cents = found?.offer.priceCents ?? p?.featured?.priceCents ?? 0;
  if (p?.couponCents && session.clippedCoupons.includes(p.asin)) cents -= p.couponCents;
  if (line.subscribe && p?.snsPercent) cents = Math.round((cents * (100 - p.snsPercent)) / 100);
  return cents;
}

export function cartSubtotal(session: Session): { cents: number; count: number } {
  let cents = 0;
  let count = 0;
  for (const line of session.active) {
    cents += linePrice(session, line) * line.quantity;
    count += line.quantity;
  }
  return { cents, count };
}

function findLine(
  session: Session,
  itemId: string,
): { list: "active" | "saved"; index: number } | null {
  const a = session.active.findIndex((l) => l.itemId === itemId);
  if (a >= 0) return { list: "active", index: a };
  const s = session.saved.findIndex((l) => l.itemId === itemId);
  if (s >= 0) return { list: "saved", index: s };
  return null;
}

const fail = (message: string): MutationResult => ({ ok: false, message });

/** Add an offer to the cart. Merges with an existing line of the same offer. */
export function addToCart(
  session: Session,
  olid: string,
  quantity: number,
  options: { subscribe?: boolean } = {},
): MutationResult {
  const found = findOffer(olid);
  if (!found) return fail("That offer is no longer available.");
  const { product: p } = found;
  if (p.scenario === "unavailable") return fail("This item is currently unavailable.");
  const qty = Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1;
  const subscribe = options.subscribe === true && p.snsPercent !== undefined;
  let line = session.active.find((l) => l.olid === olid && l.subscribe === subscribe);
  if (line) line.quantity += qty;
  else {
    line = { itemId: uuid(session.random), asin: p.asin, olid, quantity: qty, subscribe };
    session.active.push(line);
  }
  if (p.limit !== undefined && line.quantity > p.limit) {
    line.quantity = p.limit;
    line.notice = `This item has a limit of ${p.limit} per customer. The quantity was changed.`;
  }
  const result: MutationResult = { ok: true, message: "Added to Cart" };
  if (p.planAsin) result.upsell = p.planAsin;
  return result;
}

export function setQuantity(session: Session, itemId: string, quantity: number): MutationResult {
  const at = findLine(session, itemId);
  if (!at || at.list !== "active") return fail("That item is not in your cart.");
  const line = session.active[at.index]!;
  if (!Number.isFinite(quantity) || quantity < 0) return fail("Invalid quantity.");
  if (quantity === 0) {
    session.active.splice(at.index, 1);
    return { ok: true, message: "was removed from Shopping Cart." };
  }
  const p = product(line.asin);
  line.quantity = Math.floor(quantity);
  delete line.notice;
  if (p?.limit !== undefined && line.quantity > p.limit) {
    line.quantity = p.limit;
    line.notice = `This item has a limit of ${p.limit} per customer. The quantity was changed.`;
  }
  return { ok: true, message: "Quantity updated." };
}

export type CartAction = "delete" | "save-for-later" | "move-to-cart" | "delete-saved";

export function cartAction(session: Session, action: CartAction, itemId: string): MutationResult {
  const at = findLine(session, itemId);
  if (!at) return fail("That item is not in your cart.");
  const wanted = action === "delete" || action === "save-for-later" ? "active" : "saved";
  if (at.list !== wanted) return fail("That control does not belong to this item.");
  const from = at.list === "active" ? session.active : session.saved;
  const [line] = from.splice(at.index, 1);
  if (action === "save-for-later") session.saved.unshift({ ...line!, subscribe: false });
  if (action === "move-to-cart") session.active.push(line!);
  const messages: Record<CartAction, string> = {
    delete: "was removed from Shopping Cart.",
    "save-for-later": "has been moved to Saved For Later.",
    "move-to-cart": "has been moved to Shopping Cart.",
    "delete-saved": "was removed from Saved For Later.",
  };
  return { ok: true, message: messages[action] };
}

export function clipCoupon(session: Session, asin: string): MutationResult {
  const p = product(asin);
  if (!p?.couponCents) return fail("No coupon for this item.");
  if (!session.clippedCoupons.includes(asin)) session.clippedCoupons.push(asin);
  return { ok: true, message: "Coupon clipped" };
}

// ---- lists

export function findList(session: Session, listId: string): WishList | undefined {
  return session.lists.find((l) => l.id === listId);
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : null;
}

function privacyOf(value: unknown): Privacy | null {
  return value === "private" || value === "shared" || value === "public" ? value : null;
}

export function createList(session: Session, name: unknown, privacy: unknown): MutationResult {
  const n = cleanName(name);
  if (!n) return fail("Enter a list name.");
  const id = code(session.random, "3", 13);
  session.lists.push({
    id,
    name: n,
    privacy: privacyOf(privacy) ?? "private",
    isDefault: false,
    items: [],
  });
  return { ok: true, message: `List created: ${id}` };
}

export function updateList(
  session: Session,
  listId: string,
  changes: { name?: unknown; privacy?: unknown; delete?: boolean },
): MutationResult {
  const list = findList(session, listId);
  if (!list) return fail("That list does not exist.");
  if (changes.delete) {
    session.lists = session.lists.filter((l) => l.id !== listId);
    if (list.isDefault && session.lists[0]) session.lists[0].isDefault = true;
    return { ok: true, message: "List deleted." };
  }
  if (changes.name !== undefined) {
    const n = cleanName(changes.name);
    if (!n) return fail("Enter a list name.");
    list.name = n;
  }
  if (changes.privacy !== undefined) {
    const p = privacyOf(changes.privacy);
    if (!p) return fail("Unknown privacy setting.");
    list.privacy = p;
  }
  return { ok: true, message: "List settings saved." };
}

export function addToList(session: Session, listId: string, asin: string): MutationResult {
  const list = findList(session, listId);
  const p: Product | undefined = product(asin);
  if (!list) return fail("That list does not exist.");
  if (!p) return fail("That item does not exist.");
  const existing = list.items.find((i) => i.asin === asin);
  if (existing) {
    existing.requested += 1;
    return { ok: true, message: "Item already on the list; quantity updated." };
  }
  list.items.unshift({
    itemId: code(session.random, "I", 14),
    asin,
    added: ADDED,
    comment: "",
    requested: 1,
    has: 0,
    priority: "medium",
  });
  return { ok: true, message: `1 item added to ${list.name}` };
}

export function removeFromList(session: Session, listId: string, itemId: string): MutationResult {
  const list = findList(session, listId);
  if (!list) return fail("That list does not exist.");
  const before = list.items.length;
  list.items = list.items.filter((i) => i.itemId !== itemId);
  if (list.items.length === before) return fail("That item is not on the list.");
  return { ok: true, message: "Deleted" };
}

export function updateListItem(
  session: Session,
  listId: string,
  itemId: string,
  changes: { comment?: unknown; requested?: unknown; priority?: unknown },
): MutationResult {
  const item = findList(session, listId)?.items.find((i) => i.itemId === itemId);
  if (!item) return fail("That item is not on the list.");
  if (typeof changes.comment === "string") item.comment = changes.comment.slice(0, 500);
  if (changes.requested !== undefined) {
    const n = Number(changes.requested);
    if (!Number.isInteger(n) || n < 1 || n > 999) return fail("Invalid quantity.");
    item.requested = n;
  }
  if (changes.priority !== undefined) {
    if (!PRIORITIES.includes(changes.priority as Priority)) return fail("Unknown priority.");
    item.priority = changes.priority as Priority;
  }
  return { ok: true, message: "Saved" };
}

export function moveListItem(
  session: Session,
  listId: string,
  itemId: string,
  toListId: string,
  copy = false,
): MutationResult {
  const from = findList(session, listId);
  const to = findList(session, toListId);
  if (!from || !to) return fail("That list does not exist.");
  if (from === to) return fail("The item is already on that list.");
  const item = from.items.find((i) => i.itemId === itemId);
  if (!item) return fail("That item is not on the list.");
  if (!copy) from.items = from.items.filter((i) => i.itemId !== itemId);
  to.items.unshift(copy ? { ...item, itemId: code(session.random, "I", 14) } : item);
  return { ok: true, message: `Moved to ${to.name}` };
}

/** JSON view for `GET /__mock/state`. */
export function sessionView(session: Session): Record<string, unknown> {
  const line = (l: CartLine): Record<string, unknown> => ({
    item_id: l.itemId,
    asin: l.asin,
    offer: l.olid,
    quantity: l.quantity,
    subscribe: l.subscribe,
    price_cents: linePrice(session, l),
    ...(l.notice ? { notice: l.notice } : {}),
  });
  return {
    id: session.id,
    cart: {
      active: session.active.map(line),
      saved: session.saved.map(line),
      subtotal_cents: cartSubtotal(session).cents,
    },
    lists: session.lists.map((l) => ({
      id: l.id,
      name: l.name,
      privacy: l.privacy,
      is_default: l.isDefault,
      items: l.items.map((i) => ({ ...i })),
    })),
    clipped_coupons: [...session.clippedCoupons],
  };
}

export type { Offer };
