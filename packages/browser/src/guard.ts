import type { Page } from "playwright-core";
import { rawClient, type RawCdpClient } from "./attach.ts";
import { checkRequest, isAmazonHost, type Verdict } from "./policy.ts";

/** What a third-party page may load besides its own document. */
export const PASSIVE_RESOURCE_TYPES: readonly string[] = ["Image", "Stylesheet", "Font"];

/**
 * Network-level enforcement of the URL policy on one automation tab.
 *
 * Playwright's route() alone is not enough: it does not see redirect hops (it continues
 * redirected requests itself). So a catch-all route keeps request interception enabled,
 * and a listener PREPENDED on the page's raw CDP session inspects every paused request,
 * redirect hops included, and fails the denied ones before Playwright can continue them.
 *
 * Service workers are bypassed for the tab: a site's service worker otherwise fetches
 * top-level pages itself, outside page-level interception, and the guard would never see
 * those navigations. The guard also counts the main-frame documents it has inspected, so
 * the session can refuse to continue when a navigation happened that the guard did not
 * see (fail closed).
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
  request: {
    url: string;
    method: string;
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: { bytes?: string }[];
  };
}

export interface Guard {
  /** Requests refused since the guard was installed (most recent last, capped). */
  blocked(): readonly BlockedRequest[];
  /** Forget recorded blocks (call before a navigation to attribute blocks to it). */
  reset(): void;
  /** Main-frame document requests inspected since the last reset. */
  mainDocumentsSeen(): number;
  dispose(): Promise<void>;
}

/** The request body as text, from postData or the base64 postDataEntries. */
function readBody(request: RequestPaused["request"]): string | undefined {
  if (typeof request.postData === "string") return request.postData;
  // The browser states explicitly that there is no body at all.
  if (request.hasPostData === false) return "";
  const entries = request.postDataEntries;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  let out = "";
  for (const entry of entries) {
    if (typeof entry.bytes !== "string") return undefined;
    out += Buffer.from(entry.bytes, "base64").toString("latin1");
  }
  return out;
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
  let mainDocuments = 0;
  let thirdPartyPage = false;
  // Without this a service worker can serve navigations the guard never sees.
  await client.send("Network.setBypassServiceWorker", { bypass: true });

  const listener = (event: RequestPaused): void => {
    let verdict: Verdict;
    let isMainDocument = false;
    try {
      isMainDocument = event.resourceType === "Document" && event.frameId === topFrame;
      if (isMainDocument) {
        mainDocuments++;
        thirdPartyPage = !isAmazonHost(new URL(event.request.url).hostname);
      }
      const postData = readBody(event.request);
      verdict = checkRequest({
        url: event.request.url,
        method: event.request.method,
        isMainFrameDocument: isMainDocument,
        postData,
        hasUnreadPostData: postData === undefined,
      });
      // A page that is not the store's own (a price-history site) is only read as HTML.
      // It gets no scripts, frames or background requests, so nothing on it can act in
      // the signed-in profile.
      if (
        verdict.allow &&
        thirdPartyPage &&
        !isMainDocument &&
        !PASSIVE_RESOURCE_TYPES.includes(event.resourceType)
      ) {
        verdict = { allow: false, reason: "not_allowlisted", rule: "third-party-page" };
      }
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
      mainDocuments = 0;
    },
    mainDocumentsSeen: () => mainDocuments,
    async dispose() {
      client.removeListener("Fetch.requestPaused", listener as (payload: never) => void);
      await page.unroute("**/*").catch(() => {});
    },
  };
}
