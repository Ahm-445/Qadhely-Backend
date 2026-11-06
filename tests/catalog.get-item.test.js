// Catalog lookup by id, used to name a list item (US 15 list, US 17 notifications).
// Run from src/:  npm test

const { getCatalogItem } = require("../src/services/catalog");
const rawCatalog = require("../data/catalog.json");


describe("getCatalogItem", () => {

	test("returns the product for a known id", () => {
		const item = getCatalogItem("tamimi-137805");

		expect(item).not.toBeNull();
		expect(item.id).toBe("tamimi-137805");
		expect(item.name_en).toBe("Large White Eggs Plastic Packaging");
		expect(item.store).toBe("Tamimi");
	});

	test("finds every product in the catalog", () => {
		for (const raw of rawCatalog) {
			expect(getCatalogItem(raw.id)?.id).toBe(raw.id);
		}
	});

	test("returns null for an unknown or missing id", () => {
		expect(getCatalogItem("tamimi-0")).toBeNull();
		expect(getCatalogItem("")).toBeNull();
		expect(getCatalogItem(undefined)).toBeNull();
		expect(getCatalogItem(null)).toBeNull();
	});

});
