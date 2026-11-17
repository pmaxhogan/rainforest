import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import {
  ASIN_PATTERN,
  CAMEL_BLOCK_SIGNALS,
  CAMEL_CHART_HOSTS,
  KEEPA_GRAPH_HOST,
  PRICE_SOURCE_TERMS,
  camelChartUrl,
  camelContentRoot,
  classifyCamelBlock,
  isAllowedCamelChartUrl,
  isAsin,
  keepaGraphUrl,
  parseAmazonPriceHistory,
  parseCamelPriceHistory,
  parseLooseDate,
} from "../../src/pages/price-history.ts";
import { parseDocument, visibleTextChars } from "../../src/index.ts";

const HOST = "https://www.example.com";

function cap(kind: Capture["kind"], body: string, title = "Fake page", url = HOST): Capture {
  return {
    kind,
    url,
    final_url: url,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`,
  };
}

const CHART = "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon.png?w=700&h=400&tp=all";

interface CamelOpts {
  statsRows?: string;
  extra?: string;
  noChartImg?: boolean;
  chartSrc?: string;
  buyBox?: string;
  withIds?: boolean;
}

const STATS_ROWS_ALL = `
  <tr class="pt amazon on" data-field="amazon"><td class="fixed nowrap amazon"><span class="circle amazon">&nbsp;</span> Amazon </td>
    <td> $9.50 <small>(Nov 30, 2025)</small> </td><td> $30.00 <small>(Jan 05, 2024)</small> </td>
    <td> $14.00 <small>(Jun 27, 2026)</small> </td><td> $14.25 </td></tr>
  <tr class="pt new " data-field="new"><td class="fixed nowrap new"><span class="circle new">&nbsp;</span> 3rd Party New </td>
    <td> $10.00 <small>(Mar 01, 2025)</small> </td><td> $28.00 <small>(Feb 02, 2024)</small> </td>
    <td> $13.50 <small>(Jun 20, 2026)</small> </td><td> $15.10 </td></tr>
  <tr class="pt used " data-field="used"><td class="fixed nowrap used"><span class="circle used">&nbsp;</span> 3rd Party Used </td>
    <td> $8.00 <small>(Sep 04, 2022)</small> </td><td> $12.00 <small>(Oct 12, 2022)</small> </td>
    <td> $9.00 <small>(Jun 01, 2026)</small> </td><td> $9.80 </td></tr>`;

function camelPage(o: CamelOpts = {}): string {
  const chart = o.noChartImg
    ? ""
    : `<a href="${HOST}/go" target="_blank"><img id="summary_chart" alt="Price History Chart" src="${o.chartSrc ?? CHART}"></a>`;
  return `
<div id="page">
  <header><div id="header"><h1 class="h1l" role="banner"><a class="h1la" href="/">Example Widget Pack | Amazon price tracker / tracking, Amazon price history charts</a></h1></div></header>
  <div id="content_container"><div id="content" class="content" role="main">
    <div class="grid-x" id="product-header">
      <div class="cell"><div class="grid-x" id="product-content">
        <div class="cell"><div class="pimg_parent"><a href="${HOST}/go" id="upperpimg"><img src="https://images.example.com/placeholder.png" alt="Example Widget Pack | Amazon price tracker" class="pimg"></a></div></div>
        <div class="cell"><div>
          <h2><a href="${HOST}/product/B0FAKE0001">Example Widget Pack</a></h2>
          <p class="show-for-medium">
            <span class="product-title-field "><strong>ID</strong>: 4242</span>
            <span class="product-title-field "><strong>UPC</strong>: 000000000001</span>
            <span class="product-title-field "><strong>PRODUCT GROUP</strong>: Gadgets</span>
            <span class="product-title-field last"><strong>MODEL</strong>: WP 1</span>
          </p>
          <p><a href="${HOST}/product/B0FAKE0002" class="offers">View all sizes / colors</a></p>
        </div></div>
        <div class="cell small-12" id="summary_overlay_parent"><div class="grid-x">
          <div class="cell"><h3 id="phh3">Amazon Price History</h3>
            <p class="history-desc">This is our record of Amazon price changes for <strong>Example Widget Pack (B0FAKE0001)</strong> since we began monitoring it on on Jan 05, 2022. </p></div>
          <div class="cell"><ul class="menu horizontal bar expanded" id="tpbg">
            <li class="tp 1m first" data-field="1m" data-asin="B0FAKE0001" data-locale="US"><a data-text-xlarge="1 Month" data-field="1m" title="1 month - view data going back to Oct 17, 2026" href="?tp=1m" class="tp 1m first"><span class="show-for-xlarge" data-rf-hidden="1">1 Month</span><span class="hide-for-xlarge">1m</span></a></li>
            <li class="tp all active last" data-field="all" data-asin="B0FAKE0001" data-locale="US"><a data-text-xlarge="All" data-field="all" title="All - view data going back to Jan 05, 2022" href="?tp=all" class="tp all active last"><span class="show-for-xlarge" data-rf-hidden="1">All</span><span class="hide-for-xlarge">All</span></a></li>
          </ul></div>
          <div class="cell"><ul class="menu horizontal chart_types">
            <li class="menu-text hack pt " data-field="amazon" data-asin="B0FAKE0001" data-locale="US"><input class="checkbox pt amazon " value="amazon" id="price_type_amazon" type="checkbox" checked="checked" data-rf-hidden="1"><label for="price_type_amazon"><a href="?cpf=amazon" class="pt amazon" title="Toggle the Amazon price type in the chart.">Amazon</a></label></li>
            <li class="menu-text hack pt disabled" data-field="new" data-asin="B0FAKE0001" data-locale="US"><input class="checkbox pt new disabled" value="new" id="price_type_new" type="checkbox" disabled="disabled" data-rf-hidden="1"><label for="price_type_new"><a href="?cpf=amazon-new" class="pt new" title="We have no data for this price type.">New</a></label></li>
          </ul></div>
          <div class="cell" id="chart_parent" style="height: 300px;">
            <div id="chartplaceholder" style="display: none;" data-rf-hidden="1"><div class="spinner"></div></div>
            ${chart}
          </div>
          <div class="cell"><div class="table-scroll camelegend"><table>
            <thead><tr><th class="fixed"><span class="circle empty"></span> Price Type </th><th> Lowest Ever </th><th> Highest Ever </th><th> Current <span title="Last checked Nov 12, 2026.">+</span> </th><th> Average </th></tr></thead>
            <tbody>${o.statsRows ?? STATS_ROWS_ALL}</tbody></table></div></div>
          <div class="cell"><p class="history-desc">The site monitors prices across three Price Types: Amazon, Third Party New, and Third Party Used.</p></div>
          <div class="cell"><div class="input-group shareform"><span class="input-group-label">Share:</span><input aria-label="Share:" readonly="readonly" type="text" name="shareurl" id="shareurl" value="https://short.example.com/US/B0FAKE0001" class="input-group-field"></div></div>
        </div></div>
        <div class="cell"><h3>Product Details</h3><table class="product_fields"><tbody>
          <tr class="odd"><td><strong>Product group</strong></td><td>Gadg<wbr>ets</td></tr>
          <tr class="even"><td><strong>List price</strong></td><td>$15<wbr>.00</td></tr>
          <tr class="odd"><td><strong>Last update scan</strong></td><td>5 days ago</td></tr>
          <tr class="even"><td><strong>Last tracked</strong></td><td>1 day ago</td></tr>
        </tbody></table></div>
      </div></div>
      <div class="cell" id="buy-box-parent">
        <div class="price-watch-popup loaded" id="price-watch-popup" data-rf-hidden="1"><form><h3>Set Your Desired Price</h3></form></div>
        <div id="buy-box"><div class="top"><div class="grid-x">
          ${
            o.buyBox ??
            `<div class="cell"><span class=" bgp">$14.00</span><br><span class="price-type-label">Amazon Price</span><br><span class="pricing-date">as of Jun 27, 2026 01:02 AM</span></div>
          <div class="cell buy-box-togglee hide" data-rf-hidden="1"><span class="smaller bgp">Out of Stock</span><br><span class="price-type-label">3rd Party New Price</span></div>`
          }
          <div class="cell"><a href="${HOST}/go2" target="_blank" class="button expanded buy">View at Amazon</a></div>
        </div></div>
        <div class="bottom"><div id="existing-price-watches"><h3>Your Amazon Price Watches</h3><p>We will notify you when the price drops.</p><div class="grid-x"></div></div>
          <a class="add-price-watch blue button expanded" href="#">+ Add Amazon Price Watch</a></div></div>
      </div>
    </div>
    ${o.extra ?? ""}
    <div class="grid-x"><div class="cell"><h3><a href="/highlights" class="view-all">Highlighted Deals</a></h3>
      <div id="ptable_fake" class="ptable carousel"><div class="slide"><div class="product-card">
        <a href="${HOST}/product/B0FAKE0009" class="truncy_title" title="Price history for Sample Gizmo">Sample Gizmo</a>
        <div class="current_price">$4.88</div><div class="compare_price">Avg: $6.57</div></div></div></div>
    </div></div>
  </div></div>
  <footer><div id="footer">Footer text</div></footer>
</div>`;
}

const camel = (o?: CamelOpts, url = `${HOST}/product/B0FAKE0001`): Capture =>
  cap("price_history_camel", camelPage(o), "Example Widget Pack price history", url);

describe("security-relevant constants", () => {
  it("chart host allowlist is exactly the expected list", () => {
    expect([...CAMEL_CHART_HOSTS]).toEqual(["charts.camelcamelcamel.com"]);
    expect(CAMEL_CHART_HOSTS).toContain("charts.camelcamelcamel.com");
    expect(KEEPA_GRAPH_HOST).toBe("graph.keepa.com");
  });

  it("accepts only https URLs on exactly the charts host", () => {
    const good = [
      "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon.png?w=1",
      "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon-new-used.png",
    ];
    for (const u of good) expect(isAllowedCamelChartUrl(u)).toBe(true);
    const bad = [
      "http://charts.camelcamelcamel.com/us/B0FAKE0001/amazon.png",
      "https://camelcamelcamel.com/us/B0FAKE0001/amazon.png",
      "https://evil.example.com/charts.camelcamelcamel.com/x.png",
      "https://charts.camelcamelcamel.com.evil.example.com/x.png",
      "https://evilcharts.camelcamelcamel.com/x.png",
      "https://user@charts.camelcamelcamel.com/x.png",
      "https://charts.camelcamelcamel.com@evil.example.com/x.png",
      "//charts.camelcamelcamel.com/x.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "",
      "not a url",
    ];
    for (const u of bad) expect(isAllowedCamelChartUrl(u)).toBe(false);
  });

  it("source terms are neutral single sentences naming the source", () => {
    expect(Object.keys(PRICE_SOURCE_TERMS).sort()).toEqual(["amazon", "camelcamelcamel", "keepa"]);
    expect(PRICE_SOURCE_TERMS.camelcamelcamel).toMatch(/low volume/);
    expect(PRICE_SOURCE_TERMS.camelcamelcamel).toMatch(/restrict automated access/);
    expect(PRICE_SOURCE_TERMS.keepa).toMatch(/low volume/);
    expect(PRICE_SOURCE_TERMS.keepa).toMatch(/restrict automated access/);
    expect(PRICE_SOURCE_TERMS.amazon).toMatch(/Amazon/);
    for (const v of Object.values(PRICE_SOURCE_TERMS)) {
      expect(v).toMatch(/^[A-Z][^.]*\.$/);
      expect(v).not.toMatch(/[^\x20-\x7e]/);
    }
  });
});

describe("URL helpers", () => {
  it("builds the keepa URL byte for byte", () => {
    expect(keepaGraphUrl("B0FAKE0001")).toBe(
      "https://graph.keepa.com/pricehistory.png?asin=B0FAKE0001&domain=com",
    );
    expect(
      keepaGraphUrl("B0FAKE0001", {
        range: 90,
        width: 800,
        height: 400,
        amazon: true,
        new: false,
        used: true,
      }),
    ).toBe(
      "https://graph.keepa.com/pricehistory.png?asin=B0FAKE0001&domain=com&range=90&width=800&height=400&amazon=1&new=0&used=1",
    );
  });

  it("builds the camel chart URL and passes its own allowlist", () => {
    const url = camelChartUrl("B0FAKE0001", "amazon");
    expect(url).toBe(
      "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon.png?zero=0&w=800&h=400&desired=false&legend=1&tp=all&lang=en",
    );
    expect(isAllowedCamelChartUrl(url)).toBe(true);
    expect(
      camelChartUrl("B0FAKE0001", ["used", "amazon"], {
        period: "1y",
        width: 300,
        height: 200,
        legend: false,
      }),
    ).toBe(
      "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon-used.png?zero=0&w=300&h=200&desired=false&legend=0&tp=1y&lang=en",
    );
    expect(camelChartUrl("B0FAKE0001", ["new", "amazon", "used"])).toContain(
      "/amazon-new-used.png?",
    );
  });

  it("rejects bad ASINs and bad options with invalid_arguments", () => {
    const badAsins = [
      "",
      "b0fake0001",
      "B0FAKE001",
      "B0FAKE00011",
      "B0FAKE000!",
      "B0FAKE0001 ",
      "../etc/passwd",
      "B0FAKE0001&x=1",
    ];
    for (const a of badAsins) {
      expect(isAsin(a)).toBe(false);
      for (const fn of [() => keepaGraphUrl(a), () => camelChartUrl(a, "amazon")]) {
        try {
          fn();
          expect.unreachable("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RfError);
          expect((e as RfError).payload.code).toBe("invalid_arguments");
        }
      }
    }
    expect(() => keepaGraphUrl(undefined as unknown as string)).toThrow(RfError);
    expect(() => keepaGraphUrl("B0FAKE0001", { range: 0 })).toThrow(RfError);
    expect(() => keepaGraphUrl("B0FAKE0001", { range: 1.5 })).toThrow(RfError);
    expect(() => keepaGraphUrl("B0FAKE0001", { width: 99999 })).toThrow(RfError);
    expect(() => keepaGraphUrl("B0FAKE0001", { domain: "de" as unknown as "com" })).toThrow(
      RfError,
    );
    expect(() => camelChartUrl("B0FAKE0001", [])).toThrow(RfError);
    expect(() => camelChartUrl("B0FAKE0001", "bogus" as unknown as "amazon")).toThrow(RfError);
    expect(() =>
      camelChartUrl("B0FAKE0001", "amazon", { period: "9y" as unknown as "all" }),
    ).toThrow(RfError);
    expect(() => camelChartUrl("B0FAKE0001", "amazon", { width: 5 })).toThrow(RfError);
  });

  it("ASIN pattern accepts fake and real shapes", () => {
    expect(ASIN_PATTERN.test("B0FAKE0001")).toBe(true);
    expect(ASIN_PATTERN.test("0123456789")).toBe(true);
    expect(ASIN_PATTERN.test("012345678X")).toBe(true);
  });
});

describe("parseLooseDate", () => {
  it("parses named and ISO dates and rejects the rest", () => {
    expect(parseLooseDate("Nov 30, 2025")).toBe("2025-11-30");
    expect(parseLooseDate("November 3 2025")).toBe("2025-11-03");
    expect(parseLooseDate("As of Jun 27, 2026 03:02 AM")).toBe("2026-06-27");
    expect(parseLooseDate("2026-02-28")).toBe("2026-02-28");
    expect(parseLooseDate("Feb 30, 2026")).toBeUndefined();
    expect(parseLooseDate("Foo 3, 2026")).toBeUndefined();
    expect(parseLooseDate("5 days ago")).toBeUndefined();
    expect(parseLooseDate("03/04/2026")).toBeUndefined();
    expect(parseLooseDate(undefined)).toBeUndefined();
  });
});

describe("parseCamelPriceHistory: full page", () => {
  const r = parseCamelPriceHistory(camel());
  const d = r.data;

  it("is not blocked and parses product identity", () => {
    expect(d.blocked).toBe(false);
    expect(d.title).toBe("Example Widget Pack");
    expect(d.asin).toBe("B0FAKE0001");
    expect(d.locale).toBe("US");
    expect(d.image_url).toBe("https://images.example.com/placeholder.png");
    expect(d.variants_url).toBe(`${HOST}/product/B0FAKE0002`);
    expect(d.share_url).toBe("https://short.example.com/US/B0FAKE0001");
    expect(d.state).toBe("ok");
    expect(r.meta.strategies["title"]).toBe("id");
    expect(r.meta.strategies["asin"]).toBe("data-attr");
    expect(r.meta.warnings).toEqual([]);
  });

  it("parses all three price types with values and dates", () => {
    expect(d.stats.map((s) => s.type)).toEqual(["amazon", "new", "used"]);
    expect(d.stats.map((s) => s.label)).toEqual(["Amazon", "3rd Party New", "3rd Party Used"]);
    const amazon = d.stats[0];
    expect(amazon?.has_data).toBe(true);
    expect(amazon?.lowest?.amount).toBe(9.5);
    expect(amazon?.lowest_date_raw).toBe("Nov 30, 2025");
    expect(amazon?.lowest_date).toBe("2025-11-30");
    expect(amazon?.highest?.amount).toBe(30);
    expect(amazon?.highest_date).toBe("2024-01-05");
    expect(amazon?.current?.amount).toBe(14);
    expect(amazon?.current_date).toBe("2026-06-27");
    expect(amazon?.average?.amount).toBe(14.25);
    expect(amazon?.average?.currency).toBe("USD");
    expect(d.stats[1]?.current?.amount).toBe(13.5);
    expect(d.stats[2]?.lowest?.amount).toBe(8);
    expect(r.meta.strategies["stats"]).toBe("id");
  });

  it("parses the last-checked hint, monitoring date and product fields", () => {
    expect(d.last_checked_raw).toBe("Nov 12, 2026");
    expect(d.last_checked).toBe("2026-11-12");
    expect(d.monitoring_since_raw).toBe("Jan 05, 2022");
    expect(d.monitoring_since).toBe("2022-01-05");
    expect(d.product_fields["id"]).toBe("4242");
    expect(d.product_fields["upc"]).toBe("000000000001");
    expect(d.product_fields["model"]).toBe("WP 1");
    expect(d.product_fields["product_group"]).toBe("Gadgets");
    expect(d.list_price?.amount).toBe(15);
    expect(d.last_update_scan).toBe("5 days ago");
    expect(d.last_tracked).toBe("1 day ago");
  });

  it("parses the period switcher and the price type toggles", () => {
    expect(d.periods.map((p) => p.key)).toEqual(["1m", "all"]);
    expect(d.active_period).toBe("all");
    expect(d.periods[0]?.label).toBe("1 Month");
    expect(d.periods[0]?.since).toBe("2026-10-17");
    expect(d.price_type_toggles.map((t) => [t.type, t.selected, t.no_data])).toEqual([
      ["amazon", true, false],
      ["new", false, true],
    ]);
  });

  it("parses the buy box including collapsed out-of-stock rows", () => {
    expect(d.buy_box).toEqual([
      {
        type: "amazon",
        label: "Amazon",
        price: { amount: 14, currency: "USD", raw: "$14.00" },
        as_of_raw: "Jun 27, 2026 01:02 AM",
        as_of_date: "2026-06-27",
      },
      { type: "new", label: "3rd Party New", availability: "Out of Stock" },
    ]);
  });

  it("returns the chart URL that passed the allowlist and no series", () => {
    expect(d.chart_urls).toEqual([CHART]);
    expect(d.series).toEqual([]);
    expect(d.price_watches).toEqual([]);
  });

  it("is JSON serializable and carries the carousel in other_sections", () => {
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const deals = r.other_sections.find((s) => /Sample Gizmo/.test(s.text));
    expect(deals).toBeDefined();
    expect(r.other_sections.some((s) => /Footer text/.test(s.text))).toBe(false);
  });

  it("accounts for every visible character of the main content", () => {
    const html = camelPage();
    const doc = parseDocument(html);
    const total = visibleTextChars(doc, { root: camelContentRoot(doc) });
    expect(r.meta.unparsed_text_chars).toBeGreaterThanOrEqual(0);
    expect(r.meta.unparsed_text_chars / total).toBeLessThan(0.05);
  });
});

describe("parseCamelPriceHistory: edge cases", () => {
  it("handles a type with no data (dash cells)", () => {
    const rows = `
      <tr class="pt amazon on" data-field="amazon"><td>Amazon</td><td>$5.00 <small>(Jan 02, 2025)</small></td><td>$7.00 <small>(Feb 03, 2025)</small></td><td>$6.00 <small>(Mar 04, 2025)</small></td><td>$6.10</td></tr>
      <tr class="pt new" data-field="new"><td>3rd Party New</td><td> - </td><td> - </td><td> - </td><td> - </td></tr>
      <tr class="pt used" data-field="used"><td>3rd Party Used</td><td>$3.00 <small>(Jan 02, 2024)</small></td><td>$4.00 <small>(Feb 03, 2024)</small></td><td> - </td><td>$3.40</td></tr>`;
    const { data } = parseCamelPriceHistory(camel({ statsRows: rows }));
    const [amazon, third, used] = data.stats;
    expect(amazon?.has_data).toBe(true);
    expect(third?.has_data).toBe(false);
    expect(third?.current).toBeUndefined();
    expect(third?.lowest).toBeUndefined();
    expect(third?.cells_raw).toEqual({ lowest: "-", highest: "-", current: "-", average: "-" });
    expect(used?.has_data).toBe(true);
    expect(used?.current).toBeUndefined();
    expect(used?.average?.amount).toBe(3.4);
    expect(data.state).toBe("ok");
  });

  it("flags a page where every type has no data", () => {
    const rows = `<tr data-field="amazon"><td>Amazon</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>`;
    const { data } = parseCamelPriceHistory(camel({ statsRows: rows }));
    expect(data.state).toBe("no_data");
    expect(data.stats[0]?.has_data).toBe(false);
  });

  it("falls back to positional columns when the header is unreadable", () => {
    const html = camelPage().replace(/<thead>.*?<\/thead>/s, "");
    const r = parseCamelPriceHistory(cap("price_history_camel", html));
    expect(r.data.stats[0]?.lowest?.amount).toBe(9.5);
    expect(r.meta.warnings.some((w) => /positional/.test(w))).toBe(true);
  });

  it("maps columns by header text, not position", () => {
    const html = camelPage({
      statsRows: `<tr data-field="amazon"><td>Amazon</td><td>$2.00</td><td>$1.00 <small>(Jan 02, 2025)</small></td><td>$3.00 <small>(Feb 03, 2025)</small></td><td>$2.50</td></tr>`,
    }).replace(
      /<thead>.*?<\/thead>/s,
      '<thead><tr><th>Price Type</th><th> Average </th><th> Lowest Ever </th><th> Highest Ever </th><th> Current <span title="Last checked Jan 02, 2026.">+</span> </th></tr></thead>',
    );
    const r = parseCamelPriceHistory(cap("price_history_camel", html));
    const s = r.data.stats[0];
    expect(s?.average?.amount).toBe(2);
    expect(s?.lowest?.amount).toBe(1);
    expect(s?.highest?.amount).toBe(3);
    expect(s?.current?.amount).toBe(2.5);
  });

  it("uses fallback strategies for title and asin and skips hidden nodes", () => {
    const html = camelPage()
      .replace(/<h2><a [^>]*>Example Widget Pack<\/a><\/h2>/, "")
      .replace(/ data-asin="B0FAKE0001"/g, "")
      .replace(/<input aria-label="Share:"[^>]*>/, "");
    const r = parseCamelPriceHistory(
      cap("price_history_camel", html, "t", `${HOST}/product/B0FAKE0001`),
    );
    expect(r.data.title).toBe("Example Widget Pack");
    expect(r.meta.strategies["title"]).toBe("label");
    expect(r.data.asin).toBe("B0FAKE0001");
    expect(r.meta.strategies["asin"]).toBe("label");
    const hidden = camelPage().replace(
      '<div class="cell" id="chart_parent"',
      '<div data-rf-hidden="1"><img src="https://charts.camelcamelcamel.com/us/B0FAKE0003/amazon.png"></div><div class="cell" id="chart_parent"',
    );
    expect(parseCamelPriceHistory(cap("price_history_camel", hidden)).data.chart_urls).toEqual([
      CHART,
    ]);
  });

  it("rebuilds the chart URL from the inline script when the image is missing", () => {
    const script = `<script>for_onload(function() { var base_url = "https://" + "charts.camelcamelcamel.com" + "__us__B0FAKE0001__ZZZZGOOGLEPLSforce=1&zero=0&w=XXXX&h=YYYY&tp=all&lang=en"; base_url = base_url.replace(/__/g, "/"); });</script>`;
    const r = parseCamelPriceHistory(camel({ noChartImg: true, extra: script }));
    expect(r.data.chart_urls).toEqual([
      "https://charts.camelcamelcamel.com/us/B0FAKE0001/amazon.png?force=1&zero=0&w=800&h=400&tp=all&lang=en",
    ]);
    expect(r.meta.strategies["chart_urls"]).toBe("inline-script");
  });

  it("drops chart URLs on other hosts and warns", () => {
    const r = parseCamelPriceHistory(
      camel({
        chartSrc: "https://charts.camelcamelcamel.com.evil.example.com/us/B0FAKE0001/amazon.png",
      }),
    );
    expect(r.data.chart_urls).toEqual([]);
    expect(r.meta.warnings.some((w) => /allowlist/.test(w))).toBe(true);
  });

  it("parses a price-change table into a series per type", () => {
    const table = `<div class="cell"><h3>Last 50 Price Changes</h3><table class="price_changes">
      <thead><tr><th>Date</th><th>Amazon</th><th>3rd Party New</th></tr></thead>
      <tbody>
        <tr><td>Jun 27, 2026</td><td>$14.00</td><td>-</td></tr>
        <tr><td>May 01, 2026</td><td>$15.50</td><td>$13.00</td></tr>
      </tbody></table></div>`;
    const r = parseCamelPriceHistory(camel({ extra: table }));
    expect(r.data.series.map((s) => [s.type, s.points.length])).toEqual([
      ["amazon", 2],
      ["new", 1],
    ]);
    expect(r.data.series[0]?.points[0]).toEqual({
      date_raw: "Jun 27, 2026",
      date: "2026-06-27",
      price: { amount: 14, currency: "USD", raw: "$14.00" },
      raw: "$14.00",
    });
    expect(r.data.series[1]?.points[0]?.date).toBe("2026-05-01");
    expect(r.other_sections.some((s) => /Last 50 Price Changes/.test(s.text))).toBe(false);
  });

  it("parses a typed row table (date, type, price)", () => {
    const table = `<h3>Price History Table</h3><table>
      <tr><th>Date</th><th>Price Type</th><th>Price</th></tr>
      <tr><td>Jun 27, 2026</td><td>Amazon</td><td>$14.00</td></tr>
      <tr><td>Jun 01, 2026</td><td>3rd Party Used</td><td>$9.00</td></tr></table>`;
    const r = parseCamelPriceHistory(camel({ extra: table }));
    expect(r.data.series.map((s) => [s.type, s.points.length])).toEqual([
      ["amazon", 1],
      ["used", 1],
    ]);
  });

  it("reports the signed-in user's price watches", () => {
    const html = camelPage().replace(
      '<div class="grid-x"></div></div>\n          <a class="add-price-watch',
      '<div class="grid-x"><div class="cell">Amazon: alert below $12.00</div></div></div>\n          <a class="add-price-watch',
    );
    const r = parseCamelPriceHistory(cap("price_history_camel", html));
    expect(r.data.price_watches).toEqual(["Amazon: alert below $12.00"]);
  });

  it("emits unknown visible blocks as other_sections", () => {
    const r = parseCamelPriceHistory(
      camel({ extra: `<div id="mystery_block"><p>A banner nobody planned for</p></div>` }),
    );
    const s = r.other_sections.find((x) => x.key === "mystery_block");
    expect(s?.text).toBe("A banner nobody planned for");
  });
});

describe("parseCamelPriceHistory: not tracked", () => {
  const body = `<div id="content" role="main"><h2>Example Widget Pack</h2>
    <p>We do not currently track this product, so there is no price history to show.</p></div>`;

  it("reports a not-tracked page with its message", () => {
    const r = parseCamelPriceHistory(
      cap("price_history_camel", body, "Example", `${HOST}/product/B0FAKE0007`),
    );
    expect(r.data.blocked).toBe(false);
    expect(r.data.state).toBe("not_tracked");
    expect(r.data.state_message).toMatch(/do not currently track/);
    expect(r.data.stats).toEqual([]);
    expect(r.data.asin).toBe("B0FAKE0007");
  });

  it("reports a not-found page", () => {
    const r = parseCamelPriceHistory(
      cap("price_history_camel", `<div id="content" role="main"><h1>Product not found</h1></div>`),
    );
    expect(r.data.state).toBe("not_found");
  });

  it("throws layout_unrecognized when nothing is parseable", () => {
    try {
      parseCamelPriceHistory(
        cap("price_history_camel", `<div id="content"><p>Hello there</p></div>`),
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RfError);
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });
});

describe("bot wall and challenge classification", () => {
  const challenge = (): Capture =>
    cap(
      "price_history_camel",
      `<div class="main-wrapper"><h1>Example site</h1><h2 id="challenge-error-text">Enable JavaScript and cookies to continue</h2></div>
       <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`,
      "Just a moment...",
    );

  it("returns blocked:true with evidence for a managed challenge page", () => {
    const r = parseCamelPriceHistory(challenge());
    expect(r.data.blocked).toBe(true);
    expect(r.data.blocked_kind).toBe("bot_challenge");
    expect(r.data.blocked_evidence).toMatch(/Just a moment/);
    expect(r.data.stats).toEqual([]);
    expect(r.data.asin).toBeUndefined();
    expect(r.meta.warnings[0]).toMatch(/^blocked: /);
    expect(r.other_sections.some((s) => /Enable JavaScript/.test(s.text))).toBe(true);
  });

  it("classifies a turnstile verify-human page", () => {
    const c = cap(
      "price_history_camel",
      `<div><p>Verifying you are human. This may take a few seconds.</p><div class="cf-turnstile"></div></div>`,
      "Security check",
    );
    expect(classifyCamelBlock(c)?.kind).toBe("bot_challenge");
  });

  it("classifies a blocked page and a rate limit page", () => {
    const denied = cap(
      "price_history_camel",
      `<h1>Sorry, you have been blocked</h1><p>Cloudflare Ray ID: 1234abcd</p>`,
      "Access denied",
    );
    expect(classifyCamelBlock(denied)?.kind).toBe("access_denied");
    const limited = cap(
      "price_history_camel",
      `<h1>Error 1015</h1><p>You are being rate limited. Too many requests.</p>`,
      "Too Many Requests",
    );
    expect(classifyCamelBlock(limited)?.kind).toBe("rate_limited");
  });

  it("does not fire on one weak signal, nor on a real page that mentions the phrases", () => {
    expect(
      classifyCamelBlock(cap("price_history_camel", "<p>Please verify your email</p>", "Verify")),
    ).toBeNull();
    expect(
      classifyCamelBlock(
        cap("price_history_camel", "<p>Try again later for the 1015 sale.</p>", "Example"),
      ),
    ).toBeNull();
    const long = camelPage({
      extra: `<p>${"Too many requests were made by shoppers. ".repeat(200)} verifying you are human is hard.</p>`,
    });
    expect(
      classifyCamelBlock(cap("price_history_camel", long, "Example Widget Pack price history")),
    ).toBeNull();
    expect(parseCamelPriceHistory(camel()).data.blocked).toBe(false);
  });

  it("never blocks a real page that carries a CDN detection beacon or challenge scripts", () => {
    const beacon = `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
    const r = parseCamelPriceHistory(camel({ extra: beacon }));
    expect(r.data.blocked).toBe(false);
    expect(r.data.stats.length).toBe(3);
    const loud = `<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script><script>window._cf_chl_opt = {};</script>`;
    const r2 = parseCamelPriceHistory(camel({ extra: loud }));
    expect(r2.data.blocked).toBe(false);
    expect(r2.data.stats.length).toBe(3);
    // a short page with only the beacon is not a challenge either
    expect(
      classifyCamelBlock(cap("price_history_camel", `<p>Hello</p>${beacon}`, "Example")),
    ).toBeNull();
  });

  it("every block kind has at least two independent signals", () => {
    for (const kind of ["bot_challenge", "access_denied", "rate_limited"] as const) {
      expect(CAMEL_BLOCK_SIGNALS.filter((s) => s.kind === kind).length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Amazon
// ---------------------------------------------------------------------------------------

const INGRESS_SCRIPT = `<script type="text/javascript">(function(P) { P.when('A').execute(function (A) {
  P.now('rufus-eligible').execute('gate', function (rufusEligible) { if (rufusEligible === undefined) { A.$('#rufus-price-ingress-bb .rufus-ph-ingress-pill').hide(); } });
  A.declarative('show-rufus-price-ingress', 'click', function(event){
    window.P.when('rufus-handle-stream').execute(function (stream) { var payload = { qis: 'NileDPFakeHistory', query: 'q', metricName: 'FakeIngressMetric' }; stream(payload); });
  }); }); }(window.P));</script>`;

const PANEL_SCRIPT = `<script>var url = "/rufus/cl/render?ref=fake_ref"; var x = new XMLHttpRequest(); x.open("GET", url, true);</script>`;

function pill(id: string, position: string, marker: string, extra = ""): string {
  return `<div id="${id}" data-csa-c-type="widget" data-csa-c-nile-action-id="dp_apex_ingress_price_history_${position}_invoke_nile_backend_api" data-csa-c-group-id="dp_apex_ingress_price_history_invoke_nile_backend_api" data-csa-c-item-id="B0FAKE0001" data-query-text="Price history" data-ingress-position="${position}" data-ref-marker="${marker}" class="rufus-ingress-div-block" ${extra}>
    <span class="rufus-ph-ingress-pill"><span class="a-declarative" data-action="show-rufus-price-ingress" data-show-rufus-price-ingress="{}"><span class="rufus-ingress-badge"><span class="a-button a-button-base" id="a-autoid-${position}"><span class="a-button-inner"><input class="a-button-input" type="submit"><span class="a-button-text" aria-hidden="true"> Price history </span></span></span></span></span></span>
    ${INGRESS_SCRIPT}</div>`;
}

const PRICE_TO_PAY = `<span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $19.99 with 20 percent savings </span>
  <span class="price-line-wrapper"><span class="apex-savings-container"><span aria-hidden="true" class="a-size-large savingsPercentage apex-savings-percentage">-20%</span></span>
  <span class="a-price aok-align-center priceToPay apex-pricetopay-value"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">19<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span></span>`;

function basis(label: string, price: string, popover = ""): string {
  return `<div class="a-section a-spacing-small aok-align-center"><span><span class="apex-basisprice-feature">
    <span class="aok-relative"><span data-basisprice-label="{label} {price}" class="a-size-small aok-offscreen apex-basisprice-offscreen-label">${label}: ${price}</span>
    <span aria-hidden="true" class="a-size-small a-color-secondary basisPrice"><span class="apex-basisprice-label">${label}:</span> <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${price}</span><span aria-hidden="true">${price}</span></span></span></span>
    <span class="basisPriceLegalMessage"><span class="a-declarative" data-action="a-popover"><a class="a-link-normal" href="#"><img role="img" aria-label="Learn more" src="https://images.example.com/placeholder.png"></a></span>
    <div class="a-popover-preload" id="a-popover-preload-1" data-rf-hidden="1"><div class="apex-basisprice-legal-message-popover-content" role="dialog"><span class="a-size-base apex-basisprice-legal-message-popover-content-text">${popover}<br><a class="a-link-normal" href="/help">Learn more</a></span></div></div></span>
  </span></span></div>`;
}

const TYPICAL_POPOVER =
  "The Typical Price is determined using the 90-day median price paid by customers for the product in the Amazon store.";

interface AmazonOpts {
  basisHtml?: string;
  ingress?: boolean;
  extraInside?: string;
  extraOutside?: string;
  hiddenPill?: boolean;
}

function amazonPage(o: AmazonOpts = {}): string {
  const ingressBb =
    o.ingress === false ? "" : pill("rufus-price-ingress-bb", "buybox", "nl_fake_bb");
  const ingressCc =
    o.ingress === false
      ? ""
      : pill(
          "rufus-price-ingress-cc",
          "central",
          "nl_fake_cc",
          o.hiddenPill ? 'data-rf-hidden="1"' : "",
        );
  return `<div id="dp-container"><div id="ppd"><div id="centerCol">
    <div id="apex_desktop"><div id="apex_desktop_newAccordionRow">
      <div id="corePriceDisplay_desktop_feature_div" class="celwidget"><div class="a-section apex-core-price-identifier" data-csa-c-price-to-pay="19.99">
        ${PRICE_TO_PAY}${ingressBb}
        ${o.basisHtml ?? ""}
        ${o.extraInside ?? ""}
      </div></div>
      <div id="freeReturns_feature_div"><span>Example free returns note</span></div>
    </div>
    <div id="apex_desktop_usedAccordionRow" data-rf-hidden="1"><div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">$1.00</span></span>${basis("Typical price", "$99.00")}</div></div>
    </div></div></div>
    ${ingressCc}${o.extraOutside ?? ""}
    ${PANEL_SCRIPT}
    <div id="nav-flyout-rufus" class="rufus-panel-container" data-state="closed" data-rf-hidden="1"><div>Panel body</div></div>
    <button class="nav-rufus-disco" id="nav-rufus-disco" data-state="closed" role="button" aria-label="Open assistant panel"></button>
  </div>`;
}

const amazon = (o?: AmazonOpts): Capture =>
  cap("price_history_amazon", amazonPage(o), "Example Widget", `${HOST}/dp/B0FAKE0001`);

describe("parseAmazonPriceHistory: typical price and 30-day low", () => {
  const html = amazonPage({
    basisHtml: basis("Typical price", "$24.99", TYPICAL_POPOVER) + basis("List Price", "$29.99"),
    extraInside: `<span class="a-size-small badge">Lowest price in 30 days</span><div class="a-section"><span>Lowest price in the last 90 days: $17.50</span></div>`,
  });
  const r = parseAmazonPriceHistory(
    cap("price_history_amazon", html, "x", `${HOST}/dp/B0FAKE0001`),
  );
  const d = r.data;

  it("parses current price, savings and the typical / list prices", () => {
    expect(d.current_price?.amount).toBe(19.99);
    expect(d.savings_percent).toBe(20);
    expect(d.savings_label).toBe("-20%");
    expect(d.typical_price?.amount).toBe(24.99);
    expect(d.list_price?.amount).toBe(29.99);
    expect(d.basis_prices.map((b) => [b.kind, b.label])).toEqual([
      ["typical", "Typical price"],
      ["list", "List Price"],
    ]);
    expect(d.asin).toBe("B0FAKE0001");
  });

  it("reads the explanation from the hidden popover and its window", () => {
    expect(d.basis_prices[0]?.explanation).toBe(TYPICAL_POPOVER);
    expect(d.basis_prices[0]?.window_days).toBe(90);
    expect(d.basis_prices[1]?.explanation).toBeUndefined();
  });

  it("parses lowest-price statements with window and price", () => {
    expect(d.statements).toEqual([
      { kind: "low", text: "Lowest price in 30 days", window_days: 30, source: "main" },
      {
        kind: "low",
        text: "Lowest price in the last 90 days: $17.50",
        window_days: 90,
        price: { amount: 17.5, currency: "USD", raw: "$17.50" },
        source: "main",
      },
    ]);
    expect(r.meta.strategies["statements"]).toBe("text-anchor");
  });

  it("ignores the hidden accordion row and keeps the visible price", () => {
    expect(d.current_price?.amount).not.toBe(1);
    expect(d.basis_prices.some((b) => b.price.amount === 99)).toBe(false);
  });

  it("consumes what it parsed (no double prices in other_sections)", () => {
    const all = r.other_sections.map((s) => s.text).join(" | ");
    expect(all).not.toMatch(/Lowest price in/);
    expect(all).not.toMatch(/24\.99/);
    expect(all).not.toMatch(/percent savings/);
    expect(all).toMatch(/free returns note/);
  });
});

describe("parseAmazonPriceHistory: ingress wiring", () => {
  const r = parseAmazonPriceHistory(amazon({}));
  const ing = r.data.ingress;

  it("describes both pills with their data attributes", () => {
    expect(ing.present).toBe(true);
    expect(
      ing.entries.map((e) => [e.id, e.position, e.ref_marker, e.query_text, e.rendered]),
    ).toEqual([
      ["rufus-price-ingress-bb", "buybox", "nl_fake_bb", "Price history", true],
      ["rufus-price-ingress-cc", "central", "nl_fake_cc", "Price history", true],
    ]);
    expect(ing.entries[0]?.item_id).toBe("B0FAKE0001");
    expect(ing.entries[0]?.label).toBe("Price history");
    expect(ing.entries[0]?.nile_action_id).toBe(
      "dp_apex_ingress_price_history_buybox_invoke_nile_backend_api",
    );
    expect(r.data.asin).toBe("B0FAKE0001");
  });

  it("reads the click handler, stream parameters, gating and panel from the page", () => {
    expect(ing.declarative_action).toBe("show-rufus-price-ingress");
    expect(ing.stream_qis).toBe("NileDPFakeHistory");
    expect(ing.stream_metric_name).toBe("FakeIngressMetric");
    expect(ing.panel_render_path).toBe("/rufus/cl/render?ref=fake_ref");
    expect(ing.gated_on_assistant_eligibility).toBe(true);
    expect(ing.panel).toEqual({
      container_id: "nav-flyout-rufus",
      state: "closed",
      open_button_id: "nav-rufus-disco",
      open_button_label: "Open assistant panel",
    });
    expect(ing.mechanism).toMatch(/assistant panel/);
  });

  it("says the series is only reachable through the panel", () => {
    expect(r.data.series_available).toBe(false);
    expect(r.data.series).toBeUndefined();
    expect(r.data.series_note).toMatch(/interactive assistant panel/);
  });

  it("marks a hidden pill as not rendered", () => {
    const hidden = parseAmazonPriceHistory(amazon({ hiddenPill: true })).data.ingress;
    expect(hidden.entries.map((e) => e.rendered)).toEqual([true, false]);
  });
});

describe("parseAmazonPriceHistory: pages without price history information", () => {
  const r = parseAmazonPriceHistory(amazon({ ingress: false }));

  it("returns the current price and nothing else, with a series note", () => {
    expect(r.data.current_price?.amount).toBe(19.99);
    expect(r.data.typical_price).toBeUndefined();
    expect(r.data.list_price).toBeUndefined();
    expect(r.data.basis_prices).toEqual([]);
    expect(r.data.statements).toEqual([]);
    expect(r.data.ingress.present).toBe(false);
    expect(r.data.ingress.entries).toEqual([]);
    expect(r.data.series_available).toBe(false);
    expect(r.data.series_note).toMatch(/neither/);
    expect(r.meta.warnings).toEqual([]);
  });

  it("throws layout_unrecognized only when there is no price block at all", () => {
    try {
      parseAmazonPriceHistory(
        cap("price_history_amazon", "<div id=other><p>Nothing here</p></div>"),
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("does not throw for a price block without a price (warns instead)", () => {
    const html = `<div id="apex_desktop"><div id="corePriceDisplay_desktop_feature_div"><span>Currently unavailable</span></div></div>`;
    const res = parseAmazonPriceHistory(cap("price_history_amazon", html));
    expect(res.data.current_price).toBeUndefined();
    expect(res.meta.warnings.some((w) => /current_price/.test(w))).toBe(true);
  });
});

describe("parseAmazonPriceHistory: scoping and strategies", () => {
  it("leaves label-less (variant tile) basis prices out of typical / list", () => {
    const tile = `<div class="centralizedApexBasisPriceCSS"><span class="apex-basisprice-feature"><span class="a-price a-text-price apex-basisprice-value"><span class="a-offscreen">$44.00</span><span aria-hidden="true">$44.00</span></span></span></div>`;
    const r = parseAmazonPriceHistory(amazon({ extraInside: tile }));
    expect(r.data.typical_price).toBeUndefined();
    expect(r.data.list_price).toBeUndefined();
    expect(r.other_sections.map((s) => s.text).join(" ")).toMatch(/44\.00/);
  });

  it("falls back to the label + value markup and to a text anchor", () => {
    const noOffscreen = `<span class="apex-basisprice-feature"><span aria-hidden="true"><span class="apex-basisprice-label">List Price:</span> <span class="a-price a-text-price apex-basisprice-value"><span class="a-offscreen">$12.00</span></span></span></span>`;
    const r1 = parseAmazonPriceHistory(amazon({ extraInside: noOffscreen }));
    expect(r1.data.list_price?.amount).toBe(12);
    expect(r1.meta.strategies["basis_price"]).toBe("label");
    const anchor = `<span class="apex-basisprice-feature"><span>Typical price: $13.00</span></span>`;
    const r2 = parseAmazonPriceHistory(amazon({ extraInside: anchor }));
    expect(r2.data.typical_price?.amount).toBe(13);
    expect(r2.meta.strategies["basis_price"]).toBe("text-anchor");
  });

  it("falls back from the price element to the accessibility label and the data attribute", () => {
    const html = amazonPage()
      .replace(/<span class="a-price[^"]*priceToPay[\s\S]*?<\/span><\/span><\/span><\/span>/, "")
      .replace("$19.99 with", "$18.50 with");
    const r = parseAmazonPriceHistory(cap("price_history_amazon", html));
    expect(r.data.current_price?.amount).toBe(18.5);
    expect(r.meta.strategies["current_price"]).toBe("label");
    const noLabel = html.replace(/<span id="apex-pricetopay-accessibility-label".*?<\/span>/s, "");
    const r2 = parseAmazonPriceHistory(cap("price_history_amazon", noLabel));
    expect(r2.data.current_price?.amount).toBe(19.99);
    expect(r2.meta.strategies["current_price"]).toBe("data-attr");
  });

  it("takes savings from the accessibility label when the badge is absent", () => {
    const html = amazonPage().replace(
      /<span class="apex-savings-container">.*?<\/span><\/span>/s,
      "",
    );
    const r = parseAmazonPriceHistory(cap("price_history_amazon", html));
    expect(r.data.savings_percent).toBe(20);
    expect(r.meta.strategies["savings_percent"]).toBe("label");
  });

  it("reads a price insight badge", () => {
    const r = parseAmazonPriceHistory(
      amazon({
        extraInside: `<span class="price-insights-prominence-badge"><span class="aok-align-center price-insights-ingress-desktop-text bold">Better than usual</span></span>`,
      }),
    );
    expect(r.data.insight_text).toBe("Better than usual");
  });

  it("reads an embedded series when present and parses statements in fragments", () => {
    const json = `<script type="application/json">{"data":{"priceHistory":[["2026-01-02",21.5],{"date":"Feb 03, 2026","price":19.99}]}}</script>`;
    const c = amazon({ extraOutside: json });
    c.fragments = { panel: `<div><p>Lowest price in 30 days was $18.00</p></div>` };
    const r = parseAmazonPriceHistory(c);
    expect(r.data.series_available).toBe(true);
    expect(r.data.series?.map((p) => [p.date, p.price?.amount])).toEqual([
      ["2026-01-02", 21.5],
      ["2026-02-03", 19.99],
    ]);
    expect(r.data.statements).toEqual([
      {
        kind: "low",
        text: "Lowest price in 30 days was $18.00",
        window_days: 30,
        price: { amount: 18, currency: "USD", raw: "$18.00" },
        source: "panel",
      },
    ]);
  });

  it("ignores statements outside the price block and on other products' cards", () => {
    const card = `<ul><li class="a-carousel-card"><div id="sp_detail_B0FAKE0009"><span>Lowest price in 30 days</span></div></li></ul>`;
    const review = `<div id="reviews"><p>Great, it hit the lowest price in 30 days when I bought it.</p></div>`;
    const inBlockCard = `<li class="a-carousel-card"><span>Lowest price in 30 days</span></li>`;
    const r = parseAmazonPriceHistory(
      amazon({ extraOutside: card + review, extraInside: inBlockCard }),
    );
    expect(r.data.statements).toEqual([]);
  });

  it("finds a statement in the buy box outside the price block", () => {
    const html = amazonPage().replace(
      '<div id="nav-flyout-rufus"',
      '<div id="buybox"><span>Lowest price in 30 days</span></div><div id="nav-flyout-rufus"',
    );
    const r = parseAmazonPriceHistory(cap("price_history_amazon", html));
    expect(r.data.statements.map((x) => [x.kind, x.window_days])).toEqual([["low", 30]]);
  });

  it("reads the asin from a hidden form input when no ingress carries it", () => {
    const html = amazonPage({ ingress: false }).replace(
      '<div id="freeReturns_feature_div">',
      '<input type="hidden" id="ASIN" name="ASIN" value="B0FAKE0004" data-rf-hidden="1"><div id="freeReturns_feature_div">',
    );
    const r = parseAmazonPriceHistory(cap("price_history_amazon", html, "x", HOST));
    expect(r.data.asin).toBe("B0FAKE0004");
    expect(r.meta.strategies["asin"]).toBe("id");
  });

  it("does not mistake unrelated 30-day phrases for price statements", () => {
    const r = parseAmazonPriceHistory(
      amazon({
        extraOutside: `<p>30-Day Return Guarantee</p><p>Trending 100K+ orders in past 3 months</p><p>Hide for 30 days</p>`,
      }),
    );
    expect(r.data.statements).toEqual([]);
  });

  it("emits unknown visible blocks in the price scope as other_sections", () => {
    const r = parseAmazonPriceHistory(
      amazon({ extraInside: `<div id="surprise_feature_div"><span>Unplanned note</span></div>` }),
    );
    expect(r.other_sections.find((s) => s.key === "surprise_feature_div")?.text).toBe(
      "Unplanned note",
    );
  });

  it("is JSON serializable", () => {
    const r = parseAmazonPriceHistory(
      amazon({ basisHtml: basis("Typical price", "$24.99", TYPICAL_POPOVER) }),
    );
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});
