/**
 * warpcats.com chrome: hostname selects the brand, and the header chip is
 * the cheapest FarCat embedded in the OpenSea collection document.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");
const { clearFarcatCache, loadFarcatPreview, parseFloorFarcat } = await import(
	"./farcat.ts"
);
const { farcatChipHtml, shell } = await import("./shell.tsx");
const { siteNameForHost } = await import("./site-chrome.ts");

const CONTRACT = "0x9340204616750cb61e56437befc95172c6ff6606";
const IMAGE_A = `https://i2c.seadn.io/ethereum/${CONTRACT}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg`;
const IMAGE_B = `https://i2c.seadn.io/ethereum/${CONTRACT}/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png`;

function item(id: string, name: string, price: string, image: string): string {
	return `"tokenId":"${id}","name":"${name}","bestListing":{"pricePerItem":{"token":{"unit":${price},"symbol":"ETH"}}},"imageUrl":"${image}"`;
}

const FIXTURE = `"collectionItems":{"items":[${item("10", "FarCats #2", "0.02", IMAGE_A)},${item("1377", "FarCats #1648", "0.0008899", IMAGE_B)}]}`;

const FLOOR = {
	name: "FarCats #1648",
	tokenId: "1377",
	imageUrl: `${IMAGE_B}?w=64&h=64`,
	priceLabel: "0.0008899 ETH",
	href: `https://opensea.io/item/ethereum/${CONTRACT}/1377`,
};

describe("host", () => {
	test("warpcats.com and www are warpcats; everything else is forkcaster", () => {
		expect(siteNameForHost("warpcats.com")).toBe("warpcats");
		expect(siteNameForHost("www.warpcats.com")).toBe("warpcats");
		expect(siteNameForHost("WARPCATS.com.")).toBe("warpcats");
		expect(siteNameForHost("forkcaster.xyz")).toBe("forkcaster");
		expect(siteNameForHost("localhost")).toBe("forkcaster");
		expect(siteNameForHost("warpcats.com.evil.test")).toBe("forkcaster");
	});
});

describe("floor listing parse", () => {
	test("picks the cheapest ask, not the first item or the collection image", () => {
		expect(parseFloorFarcat(FIXTURE)).toEqual(FLOOR);
	});

	test("ignores an item whose only image is the collection logo", () => {
		const html = `"collectionItems":{"items":[{"tokenId":"1","name":"FarCats #9","bestListing":{"unit":0.1,"symbol":"ETH"},"imageUrl":"https://i2c.seadn.io/ethereum/0809f716d3254bfc88c82747dfffbc53/abcd.gif"}]}`;
		expect(parseFloorFarcat(html)).toBeNull();
	});

	test("no listings block ⇒ null", () => {
		expect(parseFloorFarcat("<html>no items</html>")).toBeNull();
	});
});

describe("bottom banner", () => {
	test("forkcaster shell has no FarCat banner", () => {
		const html = shell("zoo/0x · forkcaster", "<p>hi</p>");
		expect(html).toContain("<title>zoo/0x · forkcaster</title>");
		expect(html).toContain('href="/">forkcaster<b>.</b></a>');
		expect(html).not.toContain('class="farcat"');
	});

	test("warpcats shell brands the wordmark and banners the floor cat under the footer", () => {
		const html = shell(
			"zoo/0x · forkcaster",
			"<p>hi</p>",
			{ ogTitle: "zoo" },
			undefined,
			undefined,
			"article",
			true,
			{ site: "warpcats", farcat: FLOOR },
		);
		expect(html).toContain("<title>zoo/0x · warpcats</title>");
		expect(html).toContain('content="warpcats"');
		expect(html).toContain('href="/">warpcats<b>.</b></a>');
		const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
		expect(header).not.toContain("farcat");
		const afterFooter = html.slice(html.indexOf("</footer>"));
		expect(afterFooter).toContain('class="farcat"');
		expect(afterFooter).toContain("FarCats #1648");
		expect(afterFooter).toContain("0.0008899 ETH");
		expect(afterFooter).toContain(FLOOR.href);
		expect(afterFooter).toContain(`${IMAGE_B}?w=64&amp;h=64`);
	});

	test("a non-allowlisted image is dropped", () => {
		expect(farcatChipHtml({ ...FLOOR, imageUrl: "https://evil.test/x.jpg" })).toBe("");
		expect(farcatChipHtml({ ...FLOOR, href: "https://evil.test/item" })).toBe("");
		expect(farcatChipHtml({ ...FLOOR, priceLabel: "<script>" })).toBe("");
	});
});

describe("loader and route", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		clearFarcatCache();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearFarcatCache();
	});

	test("one collection fetch is shared, then served from the isolate cache", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(FIXTURE, { status: 200 });
		}) as typeof fetch;
		const [a, b] = await Promise.all([loadFarcatPreview(), loadFarcatPreview()]);
		expect(a).toEqual(FLOOR);
		expect(b).toEqual(FLOOR);
		expect(calls).toBe(1);
		expect(await loadFarcatPreview()).toEqual(FLOOR);
		expect(calls).toBe(1);
	});

	test("forkcaster /mcp does not fetch a FarCat", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("unexpected");
		}) as typeof fetch;
		const res = await app.request("https://forkcaster.xyz/mcp");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<title>forkcaster — MCP server</title>");
		expect(body).toContain("<h1>forkcaster MCP server</h1>");
		expect(body).not.toContain('class="farcat"');
		expect(calls).toBe(0);
	});

	test("warpcats /mcp shows the floor cat, and still brands when the fetch fails", async () => {
		globalThis.fetch = (async () => new Response(FIXTURE, { status: 200 })) as typeof fetch;
		const ok = await app.request("https://warpcats.com/mcp");
		const okBody = await ok.text();
		expect(okBody).toContain("<title>warpcats — MCP server</title>");
		expect(okBody).toContain("<h1>warpcats MCP server</h1>");
		const afterCopy = okBody.slice(okBody.indexOf("</ul>"));
		expect(afterCopy).toContain('class="farcat"');
		expect(afterCopy).toContain("0.0008899 ETH");
		expect(afterCopy).toContain(FLOOR.href);

		clearFarcatCache();
		globalThis.fetch = (async () => {
			throw new Error("down");
		}) as typeof fetch;
		const down = await app.request("https://www.warpcats.com/mcp");
		const downBody = await down.text();
		expect(downBody).toContain("<h1>warpcats MCP server</h1>");
		expect(downBody).not.toContain('class="farcat"');
	});
});
