import type { Page } from "playwright-core";
import { rawClient, type RawCdpClient } from "./attach.ts";
import { checkRequest, type Verdict } from "./policy.ts";

/**
 * Network-level enforcement of the URL policy on one automation tab.
 *
 * Playwright's route() alone is not enough: it does not see redirect hops (it continues
 * redirected requests itself). So a catch-all route keeps request interception enabled,
 * and a listener PREPENDED on the page's raw CDP session inspects every paused request,
 * redirect hops included, and fails the denied ones before Playwright can continue them.
 */

export interface BlockedRequest {
  url: string;
  method: string;
  verdict: Extract<Verdict, { allow: false }>;
  mainFrameDocument: boolean;
  at: number;
}

interface RequestPaused {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: { url: string; method: string; postData?: string; hasPostData?: boolean };
}

export interface Guard {
  /** Requests refused since the guard was installed (most recent last, capped). */
  blocked(): readonly BlockedRequest[];
  /** Forget recorded blocks (call before a navigation to attribute blocks to it). */
  reset(): void;
  dispose(): Promise<void>;
}

async function mainFrameId(client: RawCdpClient): Promise<string> {
  const tree = (await client.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const id = tree.frameTree?.frame?.id;
  if (typeof id !== "string") throw new Error("cannot determine the main frame id");
  return id;
}

export async function installGuard(
  page: Page,
  onBlock?: (blocked: BlockedRequest) => void,
): Promise<Guard> {
  const client = rawClient(page);
  const topFrame = await mainFrameId(client);
  const blocked: BlockedRequest[] = [];

  const listener = (event: RequestPaused): void => {
    let verdict: Verdict;
    let isMainDocument = false;
    try {
      isMainDocument = event.resourceType === "Document" && event.frameId === topFrame;
      verdict = checkRequest({
        url: event.request.url,
        method: event.request.method,
        isMainFrameDocument: isMainDocument,
        postData: event.request.postData,
        hasUnreadPostData:
          event.request.hasPostData === true && event.request.postData === undefined,
      });
    } catch {
      verdict = { allow: false, reason: "unparseable", rule: "exception" };
    }
    if (verdict.allow) return;
    // Sent synchronously inside the event dispatch, ahead of Playwright's own handler.
    void client
      .send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
      .catch(() => {});
    const record: BlockedRequest = {
      url: event.request.url,
      method: event.request.method,
      verdict,
      mainFrameDocument: isMainDocument,
      at: Date.now(),
    };
    blocked.push(record);
    if (blocked.length > 200) blocked.shift();
    onBlock?.(record);
  };

  client.prependListener("Fetch.requestPaused", listener as (payload: never) => void);
  // Keeps the Fetch domain enabled for every request of this page. The handler defers to
  // the browser; the decision is made by the raw listener above.
  await page.route("**/*", (route) => route.continue());

  return {
    blocked: () => blocked,
    reset: () => {
      blocked.length = 0;
    },
    async dispose() {
      client.removeListener("Fetch.requestPaused", listener as (payload: never) => void);
      await page.unroute("**/*").catch(() => {});
    },
  };
}
