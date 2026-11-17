import type { Page } from "playwright-core";

/**
 * In-page pass that marks elements which are not rendered, so pure parsers can ignore
 * Amazon's hidden templates and duplicate blocks. Only the topmost hidden element of a
 * hidden subtree is marked. The marks are removed again after serialization.
 */
const MARK_SCRIPT = `(() => {
  const ATTR = "data-rf-hidden";
  let marked = 0;
  const walk = (el) => {
    for (const child of el.children) {
      const tag = child.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD") continue;
      let shown = true;
      try {
        shown = child.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
      } catch (e) {
        shown = true;
      }
      if (!shown) {
        // display:contents has no box of its own but its children render: descend instead.
        let contents = false;
        try {
          contents = getComputedStyle(child).display === "contents";
        } catch (e) {
          contents = false;
        }
        if (contents) {
          walk(child);
          continue;
        }
        // Hidden form inputs carry state, not content: leave them readable.
        if (tag === "INPUT" && child.type === "hidden") continue;
        child.setAttribute(ATTR, "1");
        marked++;
        continue;
      }
      walk(child);
    }
  };
  if (document.body) walk(document.body);
  return marked;
})()`;

const UNMARK_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('[data-rf-hidden]')) el.removeAttribute('data-rf-hidden');
})()`;

/** Serialize the rendered DOM with hidden markers. */
export async function serializeWithHiddenMarks(
  page: Page,
): Promise<{ html: string; hidden: number }> {
  const hidden = (await page.evaluate(MARK_SCRIPT)) as number;
  try {
    const html = await page.content();
    return { html, hidden };
  } finally {
    await page.evaluate(UNMARK_SCRIPT).catch(() => {});
  }
}
