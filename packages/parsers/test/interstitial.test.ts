import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import {
  INTERSTITIAL_KINDS,
  INTERSTITIAL_SIGNALS,
  INTERSTITIAL_THRESHOLD,
  classifyInterstitial,
  parseDocument,
} from "../src/index.ts";

const HOST = "https://www.example.com";

function cap(body: string, opts: { title?: string; url?: string; head?: string } = {}): Capture {
  const url = opts.url ?? `${HOST}/dp/B0FAKE0001`;
  return {
    kind: "product",
    url,
    final_url: url,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>${opts.title ?? "Fake store"}</title>${opts.head ?? ""}</head><body>${body}</body></html>`,
  };
}

const NAV = `<div id=nav><a href="/ap/signin">Hello, sign in</a> <span>Account and Lists</span></div>`;

describe("interstitial registry", () => {
  it("has exactly the expected kinds", () => {
    expect([...INTERSTITIAL_KINDS]).toEqual([
      "captcha",
      "sign_in",
      "soft_challenge",
      "interstitial",
      "throttled",
      "not_found",
      "error",
    ]);
    expect(INTERSTITIAL_THRESHOLD).toBe(2);
  });

  it("gives every kind at least two independent signals", () => {
    for (const kind of INTERSTITIAL_KINDS) {
      expect(INTERSTITIAL_SIGNALS.filter((s) => s.kind === kind).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("classifyInterstitial", () => {
  it("classifies a normal page (with risky phrases) as null", () => {
    const normal = cap(
      `${NAV}
      <div id=dp><h1 id=title>Fake Widget Deluxe</h1>
      <div id=price>$12.34</div>
      <div id=reviews><p>Invented review: the box said sorry! something went wrong, but it works.</p>
      <p>Looking for something? This fake widget is it.</p></div>
      <form action="/cart/add"><input type=submit value="Add to Cart"></form>
      ${"<p>Filler invented description text for a normal product page.</p>".repeat(8)}
      </div>`,
    );
    expect(classifyInterstitial(normal)).toBeNull();
  });

  it("detects a captcha", () => {
    const r = classifyInterstitial(
      cap(
        `<h4>Enter the characters you see below</h4>
        <p>Sorry, we just need to make sure you're not a robot.</p>
        <img src="https://images.example.com/captcha/placeholder.jpg">
        <form action="/errors/validateCaptcha"><input id=captchacharacters name=field-keywords><button type=submit>Continue shopping</button></form>`,
      ),
    );
    expect(r?.kind).toBe("captcha");
    expect(r?.signals).toContain("field #captchacharacters");
    expect(r?.evidence.startsWith("captcha: ")).toBe(true);
    const byUrl = classifyInterstitial(
      cap("<p>x</p>", { url: `${HOST}/errors/validateCaptcha?amzn=fake` }),
    );
    expect(byUrl?.kind).toBe("captcha");
  });

  it("detects a sign-in wall by url, form and fields", () => {
    const r = classifyInterstitial(
      cap(
        `<h1>Sign in</h1><form name=signIn action="/ap/signin" method=post><input id=ap_email type=email><input id=ap_password type=password></form>`,
        { title: "Amazon Sign-In", url: `${HOST}/ap/signin?openid=fake` },
      ),
    );
    expect(r?.kind).toBe("sign_in");
    expect(r?.signals).toEqual([
      "url /ap/signin",
      "sign-in form",
      "field #ap_email / #ap_password",
      "title 'Sign-In'",
      "heading 'Sign in'",
    ]);
    const mfa = classifyInterstitial(
      cap(
        `<h1>Two-Step Verification</h1><p>Enter the fake code. Two-step verification is on.</p>`,
        {
          title: "Amazon Sign-In",
        },
      ),
    );
    expect(mfa?.kind).toBe("sign_in");
  });

  it("detects a soft challenge", () => {
    const r = classifyInterstitial(
      cap(
        `<h4>Click the button below to continue shopping</h4><form action="/errors/validateCaptcha"><button type=submit>Continue shopping</button></form>`,
      ),
    );
    expect(r?.kind).toBe("soft_challenge");
    expect(r?.score).toBe(4);
  });

  it("detects throttling", () => {
    const r = classifyInterstitial(
      cap(`<p>We're sorry. Too many requests. Please try again later.</p>`, {
        title: "503 - Service Unavailable Error",
      }),
    );
    expect(r?.kind).toBe("throttled");
    const weak = classifyInterstitial(
      cap(`<p>We're sorry, please try again in a few minutes.</p>${NAV}`),
    );
    expect(weak?.kind).toBe("throttled");
  });

  it("detects the not-found dog page", () => {
    const r = classifyInterstitial(
      cap(
        `<h2>Looking for something?</h2><p>We're sorry. The Web address you entered is not a functioning page on our site.</p><img alt="Dogs of Amazon" src="https://images.example.com/placeholder.png">`,
        { title: "Page Not Found" },
      ),
    );
    expect(r?.kind).toBe("not_found");
    expect(r?.signals).toHaveLength(4);
  });

  it("detects a generic error page", () => {
    const r = classifyInterstitial(
      cap(`<h1>Sorry! Something went wrong!</h1>${NAV}`, { title: "Sorry! Something went wrong!" }),
    );
    expect(r?.kind).toBe("error");
    const classic = classifyInterstitial(
      cap(
        `<p>Sorry! Something went wrong. An error occurred when we tried to process your request.</p>`,
      ),
    );
    expect(classic?.kind).toBe("error");
  });

  it("detects a generic interstitial", () => {
    const r = classifyInterstitial(
      cap(`<p>You are being redirected.</p>`, {
        head: `<meta http-equiv="Refresh" content="0; url=/">`,
      }),
    );
    expect(r?.kind).toBe("interstitial");
    const cookies = classifyInterstitial(
      cap(`<p>Please enable cookies to continue.</p><form action="/x"><button>Go</button></form>`),
    );
    expect(cookies?.kind).toBe("interstitial");
  });

  it("accepts custom signals, ignores throwing ones and a prebuilt document", () => {
    const c = cap("<p>custom marker</p>");
    const doc = parseDocument(c.html);
    const r = classifyInterstitial(
      c,
      [
        {
          kind: "error",
          name: "custom",
          weight: 2,
          test: (ctx) => ctx.text.includes("custom marker"),
        },
        {
          kind: "captcha",
          name: "throws",
          weight: 2,
          test: () => {
            throw new Error("bad signal");
          },
        },
      ],
      doc,
    );
    expect(r).toEqual({ kind: "error", evidence: "error: custom", score: 2, signals: ["custom"] });
  });

  it("uses url when final_url is empty", () => {
    const c = cap("<p>x</p>");
    c.url = `${HOST}/ap/signin`;
    c.final_url = "";
    const r = classifyInterstitial(c, [
      { kind: "sign_in", name: "url", weight: 2, test: (ctx) => ctx.url.includes("/ap/signin") },
    ]);
    expect(r?.kind).toBe("sign_in");
  });
});
