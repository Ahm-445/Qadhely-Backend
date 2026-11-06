// US 12 — product catalog search.
//
// The catalog is read from data/catalog.json (600 products) once, when this module is first
// loaded, and searched in memory. It is English only: the search looks at the English name and
// the English brand, and the Arabic fields in the file are never returned.

const rawCatalog = require("../../data/catalog.json");


// a missing or blank value becomes null, so the app never has to tell "" from "absent"
function cleanText(value) {
	if (typeof value !== "string") return null;

	const trimmed = value.trim();

	return trimmed === "" ? null : trimmed;
}

function cleanNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}


// the fields the app needs to show a product and to add it to a list
function toCatalogItem(raw) {
	return {
		id: raw.id,
		name_en: cleanText(raw.name_en) ?? "",
		brand_en: cleanText(raw.brand_en),
		size_value: cleanNumber(raw.size_value),
		size_unit: cleanText(raw.size_unit),
		size_text: cleanText(raw.size_text),
		image: cleanText(raw.image),
		store: cleanText(raw.store),
	};
}


// lower case, no accents, single spaces: "  Crème   FRAÎCHE " -> "creme fraiche"
function normalize(text) {
	return String(text ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}


const ENTRIES = rawCatalog
	.filter((raw) => raw && typeof raw.id === "string" && cleanText(raw.name_en) !== null)
	.map((raw, index) => ({
		index,
		item: toCatalogItem(raw),
		name: normalize(raw.name_en),
		brand: normalize(raw.brand_en),
	}));


// does the word start the text, or any word in it?
function startsAWord(text, token) {
	return text.startsWith(token) || text.includes(` ${token}`);
}


// lower is better: name starts with the query, then every word starts a word of the name,
// then every word is somewhere in the name, then the brand was needed to match
function rankOf(entry, query, tokens) {
	if (entry.name.startsWith(query)) return 0;
	if (tokens.every((token) => startsAWord(entry.name, token))) return 1;
	if (tokens.every((token) => entry.name.includes(token))) return 2;

	return 3;
}


/**
 * Products whose English name or English brand contains every word of the query,
 * case-insensitively, best matches first.
 * Resolves to { total, items } where items is the requested page.
 */
function searchCatalog(query, { limit = 20, offset = 0 } = {}) {

	const normalized = normalize(query);

	if (normalized === "") return { total: 0, items: [] };

	const tokens = normalized.split(" ");

	const matches = [];

	for (const entry of ENTRIES) {
		const haystack = `${entry.name} ${entry.brand}`;

		if (tokens.every((token) => haystack.includes(token))) {
			matches.push({ entry, rank: rankOf(entry, normalized, tokens) });
		}
	}

	matches.sort((a, b) => a.rank - b.rank || a.entry.index - b.entry.index);

	return {
		total: matches.length,
		items: matches.slice(offset, offset + limit).map((match) => match.entry.item),
	};
}


module.exports = { searchCatalog, normalize, toCatalogItem, CATALOG_SIZE: ENTRIES.length };
