import { layout } from "./layout.ts";

/**
 * Pages the rails must keep the automation tab away from, and the account-friction pages
 * the session must recognize. Each mimics the signals the interstitial classifier keys on;
 * all text is invented.
 */

/** A bare page with no storefront chrome, like the real interstitials. */
function bare(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en-us"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

export function renderCaptcha(): string {
  return bare(
    "Example storefront",
    `<div class="a-container"><h4>Enter the characters you see below</h4>
<p>Sorry, we just need to make sure you're not a robot.</p>
<form method="get" action="/errors/validateCaptcha"><img src="https://images.example.com/captcha/placeholder.jpg" alt="captcha">
<input type="text" id="captchacharacters" name="field-keywords" autocomplete="off"><button type="submit">Continue</button></form></div>`,
  );
}

export function renderCheckpoint(): string {
  return bare(
    "Example storefront",
    `<div class="a-container"><h4>Click the button below to continue shopping</h4>
<form method="get" action="/errors/validateCaptcha"><input type="hidden" name="amzn" value="0"><button type="submit" class="a-button-text">Continue shopping</button></form></div>`,
  );
}

export function renderSignIn(): string {
  return bare(
    "Example Sign-In",
    `<div class="a-container"><h1>Sign in</h1><form name="signIn" method="post" action="/ap/signin"><input type="email" id="ap_email" name="email"><input type="password" id="ap_password" name="password"><input type="submit" id="signInSubmit" value="Sign in"></form></div>`,
  );
}

export function renderCheckout(): string {
  return bare(
    "Checkout",
    `<div id="checkout-main"><h1>Review your order</h1><p>MOCK CHECKOUT TRAP: reaching this page is a test failure.</p><input type="submit" name="placeYourOrder1" value="Place your order"></div>`,
  );
}

export function renderThrottled(): string {
  return bare(
    "503 - Service Unavailable Error",
    `<div class="a-container"><p>We're sorry. Too many requests from this browser.</p><p>Please try again later.</p></div>`,
  );
}

export function renderNotFound(): string {
  return bare(
    "Page Not Found",
    `<div class="a-container"><h2>Looking for something?</h2><p>We're sorry. The Web address you entered is not a functioning page on our site.</p><img src="https://images.example.com/error/dog-placeholder.jpg" alt="Dogs of the example storefront"></div>`,
  );
}

export { layout };
