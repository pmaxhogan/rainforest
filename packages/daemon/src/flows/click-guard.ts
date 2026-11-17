import { RfError } from "@rainforest/core";
import {
  checkNavigation,
  isPurchaseControl,
  type ControlDescriptor,
  type PageContext,
} from "@rainforest/browser";
import type { Locator } from "playwright-core";

/**
 * The only way a write flow clicks. Before every click it asserts three things:
 *  1. the tab is on an allowlisted page,
 *  2. the target is the specific control the flow expects,
 *  3. the target does not look like a purchase control, whatever the selector matched.
 * Any doubt is a refusal: the click does not happen.
 */

export interface ExpectedControl {
  /** Human-readable name for error messages. */
  what: string;
  /** The control's `name` attribute must match (when given). */
  name?: RegExp;
  /** The control's `id` attribute must match (when given). */
  id?: RegExp;
  /** The control's visible text / value / aria-label must match (when given). */
  label?: RegExp;
}

const DESCRIBE = `(el) => {
  const form = el.closest ? el.closest("form") : null;
  return {
    text: (el.innerText || el.textContent || "").trim().slice(0, 200),
    id: el.id || null,
    name: el.getAttribute("name"),
    ariaLabel: el.getAttribute("aria-label"),
    value: el.getAttribute("value"),
    href: el.getAttribute("href"),
    formAction: el.getAttribute("formaction") || (form ? form.getAttribute("action") : null),
    tag: el.tagName,
    type: el.getAttribute("type"),
  };
}`;

type Described = ControlDescriptor & { tag?: string; type?: string | null };

export async function describeControl(locator: Locator): Promise<Described> {
  return (await locator.evaluate(DESCRIBE as unknown as (el: unknown) => Described)) as Described;
}

/** Pure check, exported for tests. Throws `blocked_by_policy` unless everything matches. */
export function assertClickAllowed(
  pageUrl: string,
  control: Described | null | undefined,
  expected: ExpectedControl,
): void {
  const refuse = (why: string): never => {
    throw new RfError("blocked_by_policy", `refusing to click ${expected.what}: ${why}`);
  };
  const where = checkNavigation(pageUrl);
  if (!where.allow) refuse("the tab is not on an allowed page");
  if (!control || typeof control.text !== "string")
    return refuse("the control could not be inspected");
  if (control.type === "password" || control.type === "email")
    refuse("credential fields are never touched");
  if (isPurchaseControl(control)) refuse("it looks like a purchase or irreversible control");
  if (expected.name && !(typeof control.name === "string" && expected.name.test(control.name))) {
    refuse("it is not the expected control (name)");
  }
  if (expected.id && !(typeof control.id === "string" && expected.id.test(control.id))) {
    refuse("it is not the expected control (id)");
  }
  if (expected.label) {
    const label = [control.text, control.value, control.ariaLabel]
      .filter((s): s is string => typeof s === "string")
      .join(" | ");
    if (!expected.label.test(label)) refuse("it is not the expected control (label)");
  }
  if (!expected.name && !expected.id && !expected.label)
    refuse("the flow did not say which control it expects");
}

export async function guardedClick(
  page: PageContext,
  locator: Locator,
  expected: ExpectedControl,
): Promise<void> {
  const count = await locator.count();
  if (count !== 1) {
    throw new RfError(
      "layout_unrecognized",
      `expected exactly one ${expected.what}, found ${count}`,
    );
  }
  const control = await describeControl(locator);
  assertClickAllowed(page.page.url(), control, expected);
  await locator.click({ timeout: 10_000 });
}
