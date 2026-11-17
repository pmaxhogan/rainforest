/**
 * HAND-WRITTEN synthetic raw captures for scrubber tests. Every "real" value below is
 * invented and planted on purpose so the tests can assert it does not survive. Hosts use
 * the reserved .invalid TLD; area code 999 and the ZIP 99999 are unassigned.
 */
import type { Capture } from "@rainforest/core";

/** Planted values, by leak class. None may appear anywhere in scrubbed output. */
export const PLANTED = {
  names: ["Zed Placeholder", "Zed", "Placeholder", "Quill Imaginary"],
  places: ["Nowhere Falls", "Nowhere", "Falls", "Maple Street", "Imaginary Grocer"],
  zips: ["99999", "99998"],
  asins: ["B0ABCD1234", "B0WXYZ9876", "0123456789"],
  orderIds: ["123-1234567-1234567", "D01-7654321-7654321"],
  emails: ["zed.placeholder@mail.invalid", "mail.invalid"],
  phones: ["(999) 555-1234", "999-555-1234", "555-1234"],
  cards: ["4321"],
  tokens: [
    "hGxM3Y8cH8Z5aBcDeFgHiJkL0mNoPq12345",
    "A1B2C3D4E5F6G7",
    "A2QQQQ9QQQQ8QQ",
    "4a2b6c8d-1234-4abc-9def-0123456789ab",
    "1Z999AA10123456784",
    "TBA123456789000",
  ],
  titles: ["Organic", "Widget", "Tangerine", "Gizmo", "zippy", "Frobnicator"],
  hosts: ["shop.invalid", "img.invalid", "px.invalid", "ads.invalid"],
  prices: ["12.34", "45.67", "3.21"],
  dates: ["January 5, 2025", "2025-01-05", "1/5/2025", "January 7", "Jan 5"],
  zones: ["CST", "-06:00", "GMT-0600"],
  queries: ["zippy", "frobnicator"],
  comments: ["secret comment"],
};

export const PAGE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="description" content="Zed Placeholder Organic Widget">
<title>Shop: Zed Placeholder Organic Widget &amp; Gizmo</title>
<script>var t = "B0ABCD1234"; fetch("https://px.invalid/track");</script>
<script src="https://shop.invalid/app.js"></script>
<style>.x { background: url(https://img.invalid/bg.png); }</style>
<link rel="stylesheet" href="https://shop.invalid/x.css">
</head>
<body class="a-m-us a-aui_72554-c">
<!-- secret comment 99999 -->
<div id="nav-belt">
  <div id="glow-ingress-block">
    <span id="glow-ingress-line1" class="nav-line-1">Deliver to Zed</span>
    <span id="glow-ingress-line2" class="nav-line-2">Nowhere Falls 99999</span>
  </div>
  <div id="nav-link-accountList-nav-line-1">Hello, Zed</div>
  <form id="nav-search-bar-form" action="https://shop.invalid/s/ref=nb_sb_noss" method="GET" role="search">
    <input type="text" id="twotabsearchtextbox" name="field-keywords" value="zippy frobnicator" placeholder="Search Shop" aria-label="Search Shop">
    <input type="hidden" name="anti-csrftoken-a2z" value="hGxM3Y8cH8Z5aBcDeFgHiJkL0mNoPq12345=">
  </form>
</div>
<div class="s-main-slot s-result-list s-search-results sg-row">
  <div class="s-result-item s-asin sg-col-0-of-12 s-widget-spacing-small" data-asin="B0ABCD1234" data-index="3"
       data-component-type="s-search-result" data-uuid="4a2b6c8d-1234-4abc-9def-0123456789ab"
       data-cel-widget="search_result_3" data-csa-c-type="item" data-csa-c-item-id="amzn1.asin.1.B0ABCD1234">
    <span class="a-color-secondary">Sponsored</span>
    <h2 class="a-size-mini"><a class="a-link-normal s-link-style a-text-normal"
       href="/Zippy-Organic-Tangerine-Widget/dp/B0ABCD1234/ref=sr_1_3?keywords=zippy+frobnicator&amp;qid=1736000000&amp;sr=8-3&amp;th=1"
       onclick="track(this)" style="color:red" title="Zippy Organic Tangerine Widget, 12 Pack">
       <span class="a-size-medium a-color-base a-text-normal">Zippy Organic Tangerine Widget, 12 Pack</span></a></h2>
    <div class="a-row a-size-small">
      <span aria-label="4.5 out of 5 stars"><i class="a-icon a-icon-star-small a-star-small-4-5"><span class="a-icon-alt">4.5 out of 5 stars</span></i></span>
      <span class="a-size-base s-underline-text">1,234 ratings</span>
    </div>
    <div class="a-row a-size-base a-color-secondary"><span>500+ bought in past month</span></div>
    <span class="a-price" data-a-size="xl"><span class="a-offscreen">$12.34</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">12<span class="a-price-decimal">.</span></span><span class="a-price-fraction">34</span></span></span>
    <div class="a-row"><span>List Price: $45.67</span></div>
    <div class="a-row"><span>FREE delivery Tuesday, January 7</span></div>
    <img class="s-image" src="https://img.invalid/images/I/71abcDEF12L._AC_UL320_.jpg"
         srcset="https://img.invalid/images/I/71a.jpg 1x, https://img.invalid/images/I/71b.jpg 2x" alt="Zippy Organic Tangerine Widget">
    <img src="https://px.invalid/uedata/unsticky/123/OP" width="1" height="1" alt="">
    <div class="a-section" data-rf-hidden="1"><span>Frobnicator Gizmo for Zed Placeholder</span></div>
  </div>
</div>
<div id="orderDetails" class="order-info">
  <div class="a-row"><span class="order-date-invoice-item">Order placed January 5, 2025</span></div>
  <div class="a-row"><span>Order # 123-1234567-1234567</span><bdi dir="ltr">D01-7654321-7654321</bdi></div>
  <div class="a-row"><a href="/gp/your-account/order-details/ref=ppx_yo_dt_b_order_details_o00?ie=UTF8&amp;orderID=123-1234567-1234567">View order details</a></div>
  <div class="a-row"><span>Shipped on 1/5/2025 via 1Z999AA10123456784</span> <span>Tracking TBA123456789000</span></div>
  <div id="od-subtotals">
    <div class="a-row"><span>Item(s) Subtotal:</span><span>$45.67</span></div>
    <div class="a-row"><span>Estimated tax to be collected:</span><span>$3.21</span></div>
    <div class="a-row"><span>Grand Total:</span><span>$48.88</span></div>
  </div>
  <div class="displayAddressDiv">
    <ul class="displayAddressUL">
      <li class="displayAddressFullName">Zed Placeholder</li>
      <li class="displayAddressAddressLine1">123 Maple Street</li>
      <li class="displayAddressCityStateOrRegionPostalCode">Nowhere Falls, ZZ 99999-1234</li>
      <li class="displayAddressPhoneNumber">Phone: (999) 555-1234</li>
    </ul>
  </div>
  <div class="pmts-payment-instrument">Visa ending in 4321</div>
  <div>Contact zed.placeholder@mail.invalid or call 999-555-1234 or 555-1234.</div>
</div>
<div class="delivery-message"><span>Arriving Tuesday, January 7 between 2 PM - 4 PM CST</span>
  <span>Updated 2025-01-05T10:00:00-06:00 (GMT-0600)</span></div>
<div class="fresh-window">Imaginary Grocer Nowhere Falls - Today 10:00 AM - 12:00 PM</div>
<div class="last-purchased">Last purchased Jan 5</div>
<div class="review" data-hook="review" id="R1ABCDEFGHIJKL">
  <span class="a-profile-name">Quill Imaginary</span>
  <span data-hook="review-date">Reviewed in the United States on January 5, 2025</span>
  <span data-hook="avp-badge">Verified Purchase</span>
  <span data-hook="review-body">My zippy frobnicator broke after Jan 5. Seller A2QQQQ9QQQQ8QQ ignored me.</span>
</div>
<script type="a-state" data-a-state='{"key":"turbo-checkout-page-state"}'>{"customerId":"A1B2C3D4E5F6G7","title":"Zippy Organic Tangerine Widget","price":12.34,"zip":"99999","postalCode":99998,"when":"2025-01-05T10:00:00-06:00","B0ABCD1234":{"url":"https://shop.invalid/dp/B0ABCD1234","image":"https://img.invalid/x.jpg"},"email":"zed.placeholder@mail.invalid"}</script>
<script type="application/json" id="twister-data">{"asin":"B0WXYZ9876","isbn":{"asin":"0123456789"},"labels":["In Stock","Gizmo"]}</script>
<script type="text/template"><div>Zed Placeholder</div></script>
<script type="a-state" data-a-state='not json'>{"x":"Zed"}</script>
<iframe src="https://ads.invalid/frame?u=zed" srcdoc="<p>Zed</p>"><p>Zed Placeholder</p></iframe>
<noscript><img src="https://px.invalid/noscript.gif"></noscript>
<a href="mailto:zed.placeholder@mail.invalid">Email</a> <a href="tel:9995551234">Call</a> <a href="javascript:void(0)">x</a>
<label for="R1ABCDEFGHIJKL">Helpful</label>
<p>Subscribe &amp; Save</p>
<p>Add to Cart</p>
<p>Ships from Amazon.com</p>
<p>Sold by Zed's Shop</p>
<time datetime="2025-01-05T10:00:00-06:00">Jan 5</time>
</body></html>`;

export const AOD_HTML = `<div id="aod-container"><div id="aod-offer" class="aod-information-block">
<div id="aod-offer-soldBy"><span class="a-size-small">Sold by</span> <a class="a-link-normal" href="/gp/aag/main?ie=UTF8&amp;seller=A2QQQQ9QQQQ8QQ&amp;isAmazonFulfilled=0">Zed's Tangerine Emporium</a></div>
<div id="aod-offer-price"><span class="a-offscreen">$12.34</span></div>
<div id="aod-offer-shipsFrom">Ships from Nowhere Falls, ZZ 99999</div>
</div></div>`;

export function sampleCapture(): Capture {
  return {
    kind: "product",
    url: "https://shop.invalid/Zippy-Organic-Tangerine-Widget/dp/B0ABCD1234?th=1&k=zippy+frobnicator&tag=zed-20",
    final_url: "https://shop.invalid/dp/B0ABCD1234?th=1",
    captured_at: "2025-01-08T15:30:00.000-06:00",
    html: PAGE_HTML,
    fragments: { aod: AOD_HTML },
  };
}
