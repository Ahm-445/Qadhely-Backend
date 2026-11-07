// US 12: catalog search — API tests (Jest + Supertest)
// Run from src/:  npm test
// The catalog is read from data/catalog.json, so no database is needed.

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const catalogRoutes = require("../src/routes/catalogRoutes");
const { searchCatalog, normalize, toCatalogItem, CATALOG_SIZE } = require("../src/services/catalog");
const { DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LENGTH } = require("../src/controllers/catalogController");
const rawCatalog = require("../data/catalog.json");


// small app with only the catalog routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/catalog", catalogRoutes);

// same token shape as the login response
const token = jwt.sign(
	{ id: "665f00000000000000000001", handleName: "tester", phoneNumber: "+966500000001" },
	process.env.JWT_SECRET
);

const search = (params = {}) =>
	request(app).get("/api/catalog/search").query(params).set("Authorization", `Bearer ${token}`);

const ITEM_KEYS = ["brand_en", "id", "image", "name_en", "size_text", "size_unit", "size_value", "store"];


// the protected middleware logs every token and user; keep the test output readable
beforeEach(() => {
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});



describe("GET /api/catalog/search — authentication", () => {

	test("a request without a token gets 401", async () => {
		const res = await request(app).get("/api/catalog/search").query({ q: "milk" });

		expect(res.status).toBe(401);
		expect(res.body.items).toBeUndefined();
	});

	test("an invalid token gets 401", async () => {
		const res = await request(app)
			.get("/api/catalog/search")
			.query({ q: "milk" })
			.set("Authorization", "Bearer not-a-real-token");

		expect(res.status).toBe(401);
	});

	test("a token signed with another secret gets 401", async () => {
		const forged = jwt.sign({ id: "665f00000000000000000001" }, "another-secret");

		const res = await request(app)
			.get("/api/catalog/search")
			.query({ q: "milk" })
			.set("Authorization", `Bearer ${forged}`);

		expect(res.status).toBe(401);
	});
});


describe("GET /api/catalog/search — searching", () => {

	test("the catalog has the 600 products", () => {
		expect(CATALOG_SIZE).toBe(600);
	});

	test("searching for milk returns relevant products", async () => {
		const res = await search({ q: "milk" });

		expect(res.status).toBe(200);
		expect(res.body.query).toBe("milk");
		expect(res.body.total).toBeGreaterThan(0);
		expect(res.body.items.length).toBeGreaterThan(0);
		expect(res.body.items.map((item) => item.id)).toContain("tamimi-194342");

		for (const item of res.body.items) {
			expect(`${item.name_en} ${item.brand_en ?? ""}`.toLowerCase()).toContain("milk");
		}
	});

	test("each product has exactly the fields the app needs, in English", async () => {
		const res = await search({ q: "milk" });

		for (const item of res.body.items) {
			expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
			expect(typeof item.id).toBe("string");
			expect(typeof item.name_en).toBe("string");
			expect(typeof item.store).toBe("string");
		}

		const milk = res.body.items.find((item) => item.id === "tamimi-194342");

		expect(milk).toEqual({
			id: "tamimi-194342",
			name_en: "Fresh Milk Full Fat",
			brand_en: "Almarai",
			size_value: expect.any(Number),
			size_unit: expect.any(String),
			size_text: "1L",
			image: expect.stringMatching(/^https?:\/\//),
			store: "Tamimi",
		});
	});

	test("Arabic fields are never returned", async () => {
		const res = await search({ q: "milk" });
		const body = JSON.stringify(res.body);

		for (const key of ["name_ar", "brand_ar", "barcode", "store_category", "flavor"]) {
			expect(body).not.toContain(`"${key}"`);
		}
	});

	test("the search is case-insensitive", async () => {
		const lower = await search({ q: "milk" });
		const upper = await search({ q: "MILK" });
		const mixed = await search({ q: "mIlK" });

		expect(upper.body.items).toEqual(lower.body.items);
		expect(mixed.body.items).toEqual(lower.body.items);
	});

	test("leading, trailing and repeated spaces are ignored", async () => {
		const plain = await search({ q: "fresh milk" });
		const spaced = await search({ q: "   fresh    milk  " });

		expect(spaced.body.query).toBe("fresh    milk");
		expect(spaced.body.items).toEqual(plain.body.items);
	});

	test("every word of the query has to match", async () => {
		const res = await search({ q: "fresh milk" });

		expect(res.body.total).toBeGreaterThan(0);

		for (const item of res.body.items) {
			const text = `${item.name_en} ${item.brand_en ?? ""}`.toLowerCase();

			expect(text).toContain("fresh");
			expect(text).toContain("milk");
		}
	});

	test("the English brand is searched too", async () => {
		const res = await search({ q: "almarai", limit: MAX_LIMIT });

		expect(res.body.total).toBeGreaterThan(0);

		for (const item of res.body.items) {
			expect(`${item.name_en} ${item.brand_en ?? ""}`.toLowerCase()).toContain("almarai");
		}

		expect(res.body.items.some((item) => item.brand_en === "Almarai")).toBe(true);
	});

	test("products whose name starts with the query come first", async () => {
		const res = await search({ q: "milk", limit: MAX_LIMIT });
		const startsWithMilk = res.body.items.map((item) => item.name_en.toLowerCase().startsWith("milk"));

		expect(startsWithMilk[0]).toBe(true);
		// once a name that does not start with "milk" shows up, no later one does
		expect(startsWithMilk.join(",")).not.toMatch(/false,.*true/);
	});

	test("accents do not matter", () => {
		expect(normalize("  Crème   FRAÎCHE ")).toBe("creme fraiche");
	});

	test("Arabic text finds nothing, because the search is English only", async () => {
		const res = await search({ q: "حليب" });

		expect(res.status).toBe(200);
		expect(res.body.total).toBe(0);
		expect(res.body.items).toEqual([]);
	});

	test("special characters are treated as plain text", async () => {
		const res = await search({ q: ".*(" });

		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([]);
	});
});


describe("GET /api/catalog/search — no results", () => {

	test("a query that matches nothing returns 200 with an empty list", async () => {
		const res = await search({ q: "zzzzqqqqxxxx" });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			query: "zzzzqqqqxxxx",
			total: 0,
			limit: DEFAULT_LIMIT,
			offset: 0,
			hasMore: false,
			items: [],
		});
	});

	test("searchCatalog returns nothing for an empty query", () => {
		expect(searchCatalog("")).toEqual({ total: 0, items: [] });
		expect(searchCatalog("   ")).toEqual({ total: 0, items: [] });
	});
});


describe("GET /api/catalog/search — invalid queries", () => {

	test("a missing q gets 400", async () => {
		const res = await search();

		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: "Enter a search term." });
	});

	test("an empty q gets 400", async () => {
		const res = await search({ q: "" });

		expect(res.status).toBe(400);
	});

	test("a q of only spaces gets 400", async () => {
		const res = await search({ q: "     " });

		expect(res.status).toBe(400);
	});

	test("a repeated q (an array) gets 400", async () => {
		const res = await request(app)
			.get("/api/catalog/search?q=milk&q=bread")
			.set("Authorization", `Bearer ${token}`);

		expect(res.status).toBe(400);
	});

	test("a q longer than the maximum gets 400, the maximum itself is fine", async () => {
		const tooLong = await search({ q: "a".repeat(MAX_QUERY_LENGTH + 1) });
		const longest = await search({ q: "a".repeat(MAX_QUERY_LENGTH) });

		expect(tooLong.status).toBe(400);
		expect(longest.status).toBe(200);
	});

	test.each(["0", "-1", "1.5", "abc", "", "51", "1e1", "999999999999"])("limit=%p gets 400", async (limit) => {
		const res = await search({ q: "milk", limit });

		expect(res.status).toBe(400);
		expect(res.body.error).toContain("limit");
	});

	test.each(["-1", "1.5", "abc", "", "1e1"])("offset=%p gets 400", async (offset) => {
		const res = await search({ q: "milk", offset });

		expect(res.status).toBe(400);
		expect(res.body.error).toContain("offset");
	});
});


describe("GET /api/catalog/search — pagination", () => {

	test("returns 20 products by default", async () => {
		const res = await search({ q: "a" });

		expect(res.status).toBe(200);
		expect(res.body.total).toBeGreaterThan(DEFAULT_LIMIT);
		expect(res.body.limit).toBe(20);
		expect(res.body.offset).toBe(0);
		expect(res.body.items).toHaveLength(20);
		expect(res.body.hasMore).toBe(true);
	});

	test("limit sets the page size", async () => {
		const res = await search({ q: "a", limit: 5 });

		expect(res.body.items).toHaveLength(5);
		expect(res.body.limit).toBe(5);
	});

	test("the maximum limit is allowed", async () => {
		const res = await search({ q: "a", limit: MAX_LIMIT });

		expect(res.status).toBe(200);
		expect(res.body.items).toHaveLength(MAX_LIMIT);
	});

	test("offset moves to the next page without repeating products", async () => {
		const first = await search({ q: "a", limit: 5, offset: 0 });
		const second = await search({ q: "a", limit: 5, offset: 5 });

		const firstIds = first.body.items.map((item) => item.id);
		const secondIds = second.body.items.map((item) => item.id);

		expect(secondIds).toHaveLength(5);
		expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
		expect(second.body.total).toBe(first.body.total);
		expect(second.body.offset).toBe(5);
	});

	test("walking every page returns each match exactly once, in the same order", async () => {
		const all = await search({ q: "milk", limit: MAX_LIMIT });
		const ids = [];

		for (let offset = 0; ; offset += 7) {
			const page = await search({ q: "milk", limit: 7, offset });

			ids.push(...page.body.items.map((item) => item.id));

			if (!page.body.hasMore) break;
		}

		expect(ids).toHaveLength(all.body.total);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(all.body.items.map((item) => item.id));
	});

	test("hasMore is false on the last page", async () => {
		const all = await search({ q: "milk", limit: MAX_LIMIT });
		const last = await search({ q: "milk", limit: 1, offset: all.body.total - 1 });

		expect(last.body.items).toHaveLength(1);
		expect(last.body.hasMore).toBe(false);
	});

	test("an offset past the end returns an empty page", async () => {
		const res = await search({ q: "milk", offset: 100000 });

		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([]);
		expect(res.body.total).toBeGreaterThan(0);
		expect(res.body.hasMore).toBe(false);
	});
});


describe("GET /api/catalog/search — missing brand, size or image", () => {

	const noBrand = rawCatalog.find((raw) => !(raw.brand_en || "").trim());
	const noSize = rawCatalog.find((raw) => !raw.size_value);

	test("the catalog does have products without a brand or a structured size", () => {
		expect(noBrand).toBeDefined();
		expect(noSize).toBeDefined();
	});

	test("a product without a brand has brand_en null", async () => {
		const res = await search({ q: noBrand.name_en, limit: MAX_LIMIT });
		const item = res.body.items.find((candidate) => candidate.id === noBrand.id);

		expect(item).toBeDefined();
		expect(item.brand_en).toBeNull();
	});

	test("a product without a structured size keeps size_text and has null size fields", async () => {
		const res = await search({ q: noSize.name_en, limit: MAX_LIMIT });
		const item = res.body.items.find((candidate) => candidate.id === noSize.id);

		expect(item).toBeDefined();
		expect(item.size_value).toBeNull();
		expect(item.size_text).toBe(noSize.size_text);
	});

	test("a product with missing brand, size or image maps to nulls instead of failing", () => {
		// the real catalog has an image for every product, so check the mapping rules directly
		expect(toCatalogItem({ id: "x-1", name_en: " Plain Rice " })).toEqual({
			id: "x-1",
			name_en: "Plain Rice",
			brand_en: null,
			size_value: null,
			size_unit: null,
			size_text: null,
			image: null,
			store: null,
		});

		expect(toCatalogItem({
			id: "x-2",
			name_en: "Rice",
			brand_en: "   ",
			size_value: 0,
			size_unit: "",
			size_text: "",
			image: "",
			store: "Panda",
		})).toMatchObject({ brand_en: null, size_value: null, size_unit: null, size_text: null, image: null, store: "Panda" });
	});

	test("no field of a returned product is undefined or an empty string", async () => {
		const res = await search({ q: "a", limit: MAX_LIMIT });

		for (const item of res.body.items) {
			for (const key of ITEM_KEYS) {
				expect(item[key]).not.toBeUndefined();
				expect(item[key]).not.toBe("");
			}
		}

		// and the response survives a JSON round trip unchanged
		expect(JSON.parse(JSON.stringify(res.body))).toEqual(res.body);
	});
});
