import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RfError } from "@rainforest/core";

/**
 * Opaque offer ids. `get_buying_options` mints one per offer; `add_to_cart` accepts
 * nothing else. The token is an authenticated encryption of the offer snapshot under a
 * key that lives only in this process, so it cannot be forged, read or altered by the
 * hub or the model, and it dies with the process. Tokens expire after a few minutes.
 */

export const OFFER_TOKEN_TTL_MS = 10 * 60_000;

export interface OfferSnapshot {
  asin: string;
  offer_listing_id: string;
  seller_id: string | null;
  seller_name: string | null;
  condition: string | null;
  /** Finer condition text, for example "Used - Very Good". */
  sub_condition: string | null;
  /** Price in cents at mint time. */
  price_cents: number | null;
  /** Flags known at mint time (time-independent ones). */
  flags: string[];
  out_of_stock: boolean;
  /** Where the offer was listed: the all-offers panel index, or the buy box. */
  source: "aod" | "buybox";
  index: number;
  exp: number;
}

const key = randomBytes(32);

export function mintOfferToken(snapshot: Omit<OfferSnapshot, "exp">, now: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify({ ...snapshot, exp: now + OFFER_TOKEN_TTL_MS }), "utf8");
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `o1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** Decode and verify a token. Anything wrong is one uniform refusal. */
export function readOfferToken(token: unknown, now: number): OfferSnapshot {
  const refuse = (): never => {
    throw new RfError(
      "invalid_arguments",
      "offer_id is not valid or has expired: call get_buying_options again",
    );
  };
  if (typeof token !== "string" || !token.startsWith("o1.")) return refuse();
  let snapshot: OfferSnapshot;
  try {
    const raw = Buffer.from(token.slice(3), "base64url");
    if (raw.length < 12 + 16 + 2) return refuse();
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    snapshot = JSON.parse(plain.toString("utf8")) as OfferSnapshot;
  } catch {
    return refuse();
  }
  if (typeof snapshot.exp !== "number" || snapshot.exp < now) return refuse();
  if (typeof snapshot.asin !== "string" || typeof snapshot.offer_listing_id !== "string")
    return refuse();
  return snapshot;
}
