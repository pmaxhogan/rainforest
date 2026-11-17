/** Small shared helpers: HTML escaping, money, a seeded PRNG and id generators. */

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "$1,234.50" from integer cents. */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** The `.a-price` block the parsers read (offscreen text plus the split visual parts). */
export function priceHtml(cents: number, extraClass = ""): string {
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  const fraction = String(cents % 100).padStart(2, "0");
  return (
    `<span class="a-price${extraClass ? ` ${extraClass}` : ""}" data-a-size="l"><span class="a-offscreen">${money(cents)}</span>` +
    `<span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span>` +
    `<span class="a-price-fraction">${fraction}</span></span></span>`
  );
}

/** mulberry32: tiny, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

/** A UUID-shaped cart item id. */
export function uuid(random: () => number): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += HEX[Math.floor(random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20)}`;
}

/** Uppercase alphanumeric id of `n` characters with a fixed prefix. */
export function code(random: () => number, prefix: string, n: number): string {
  let s = prefix;
  while (s.length < n) s += ALNUM[Math.floor(random() * ALNUM.length)];
  return s;
}

/** "November 16, 2026" from a Date (UTC parts). */
export function longDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Tuesday, November 17" from a Date (UTC parts). */
export function weekdayDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
