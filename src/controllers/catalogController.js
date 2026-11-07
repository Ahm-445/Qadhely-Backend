const { searchCatalog } = require("../services/catalog");


const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 100;


// a query-string number must be plain digits: "1.5", "-1", "1e3" and "" are all rejected
function parseWholeNumber(value, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return null;

	return Number(value);
}


// GET /api/catalog/search?q=milk&limit=20&offset=0
// US 12: finds catalog products by English name or English brand.
// Responds { query, total, limit, offset, hasMore, items: [...] }.
const searchCatalogItems = (req, res) => {

	const { q, limit: rawLimit, offset: rawOffset } = req.query;

	if (typeof q !== "string" || q.trim() === "") {
		return res.status(400).json({ error: "Enter a search term." });
	}

	const query = q.trim();

	if (query.length > MAX_QUERY_LENGTH) {
		return res.status(400).json({ error: `The search term must be ${MAX_QUERY_LENGTH} characters or less.` });
	}

	const limit = parseWholeNumber(rawLimit, DEFAULT_LIMIT);

	if (limit === null || limit < 1 || limit > MAX_LIMIT) {
		return res.status(400).json({ error: `The limit must be a whole number from 1 to ${MAX_LIMIT}.` });
	}

	const offset = parseWholeNumber(rawOffset, 0);

	if (offset === null) {
		return res.status(400).json({ error: "The offset must be a whole number of 0 or more." });
	}

	const { total, items } = searchCatalog(query, { limit, offset });

	return res.status(200).json({
		query,
		total,
		limit,
		offset,
		hasMore: offset + items.length < total,
		items,
	});

};


module.exports = { searchCatalogItems, DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LENGTH };
