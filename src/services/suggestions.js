const ItemHistory = require("../models/ItemHistory");
const ListItem = require("../models/ListItem");
const { getCatalogItem } = require("./catalog");

// AI suggestions — the Node half of the model.
//
// model.json is trained offline in ml/ and holds only numbers: the feature order, the scaler's mean
// and scale, the logistic regression's weights and the operating point. Scoring here is the same formula
// for every group and item, so a group the model never saw in training is scored just as well.
//
// ml/features.py is the other half of the same specification (section 5 of the plan). The two must
// compute identical features; tests/us23.suggestions.parity.test.js checks this against
// ml/out/parity_fixture.json. Change one side and the other together.

const MODEL = require("../../ml/out/model.json");

const DAY_MS = 86_400_000;

const NOT_ENOUGH_HISTORY = "NOT_ENOUGH_HISTORY";


// ISO 8601 strings, Date objects and milliseconds all become milliseconds
function toMs(value) {
	if (typeof value === "number") return value;
	if (value instanceof Date) return value.getTime();
	return Date.parse(String(value));
}


// code point order, the same order Python's sorted() gives
function compareText(a, b) {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}


/**
 * One group's rows grouped into trips, oldest first.
 *
 * A trip's time is its completion time: the earliest createdAt among its rows. Rows with no tripId
 * (an item added and never completed) and custom items (no catalogItemId) are not shopping events and
 * are left out.
 */
function tripRows(rows) {
	const byTrip = new Map();

	for (const row of rows) {
		const tripId = row.tripId === null || row.tripId === undefined ? null : String(row.tripId);
		const itemId = row.catalogItemId;

		if (!tripId || !itemId) continue;

		let trip = byTrip.get(tripId);

		if (!trip) {
			trip = { tripId, rows: [], itemIds: new Set(), time: null };
			byTrip.set(tripId, trip);
		}

		trip.rows.push(row);
		trip.itemIds.add(itemId);

		const created = toMs(row.createdAt);

		if (trip.time === null || created < trip.time) {
			trip.time = created;
		}
	}

	return [...byTrip.values()].sort((a, b) => a.time - b.time || compareText(a.tripId, b.tripId));
}


function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);

	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}


/**
 * One entry per item bought in `trips`, with the nine features of plan section 5.
 *
 * `trips` are the group's past trips, oldest first, all before `nowMs`. Every feature reads only those
 * trips, so the target trip never leaks into its own features.
 */
function candidateFeatures(trips, nowMs, fallbackMedianInterval = MODEL.fallbackMedianInterval) {
	const tripCount = trips.length;

	if (tripCount === 0) return [];

	const purchases = new Map();

	for (const trip of trips) {
		for (const itemId of trip.itemIds) {
			if (!purchases.has(itemId)) purchases.set(itemId, []);
			purchases.get(itemId).push(trip.time);
		}
	}

	const recent = trips.slice(Math.max(0, tripCount - 3));
	const recentDivisor = Math.min(3, tripCount);
	const lastTrip = trips[tripCount - 1].itemIds;
	const candidates = [];

	for (const itemId of [...purchases.keys()].sort(compareText)) {
		const times = purchases.get(itemId);
		const bought = times.length;
		const lastTime = times[times.length - 1];

		const daysSinceLast = (nowMs - lastTime) / DAY_MS;

		const intervals = [];
		for (let index = 1; index < times.length; index += 1) {
			intervals.push((times[index] - times[index - 1]) / DAY_MS);
		}

		const medianInterval = intervals.length > 0 ? median(intervals) : fallbackMedianInterval;

		let intervalCv = 1.0;

		if (intervals.length >= 2) {
			const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
			const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
			intervalCv = mean > 0 ? Math.sqrt(variance) / mean : 1.0;
		}

		candidates.push({
			catalogItemId: itemId,
			features: {
				trip_freq: bought / tripCount,
				recent_freq: recent.filter((trip) => trip.itemIds.has(itemId)).length / recentDivisor,
				log_count: Math.log1p(bought),
				days_since_last: daysSinceLast,
				trips_since_last: trips.filter((trip) => trip.time > lastTime).length,
				median_interval: medianInterval,
				due_ratio: Math.min(5, daysSinceLast / Math.max(1, medianInterval)),
				interval_cv: intervalCv,
				in_last_trip: lastTrip.has(itemId) ? 1 : 0,
			},
		});
	}

	return candidates;
}


// p = 1 / (1 + exp(-z)), z = intercept + sum of coef[i] * (x[i] - mean[i]) / scale[i]
function score(features, model = MODEL) {
	let z = model.intercept;

	model.features.forEach((name, index) => {
		z += model.coef[index] * ((features[name] - model.mean[index]) / model.scale[index]);
	});

	return 1 / (1 + Math.exp(-z));
}


// "Usually every 7 days, last bought 9 days ago", the line the admin reads under a suggestion
function reasonFor(features) {
	const days = Math.max(0, Math.round(features.days_since_last));
	const when = days === 0 ? "bought today" : `last bought ${days} day${days === 1 ? "" : "s"} ago`;
	const bought = Math.round(Math.expm1(features.log_count));

	if (bought < 2) return `Bought once, ${when}`;

	return `Usually every ${Math.max(1, Math.round(features.median_interval))} days, ${when}`;
}


// the quantity and unit the group used most often for this item, ties going to the most recent use
function usualSizing(tripRowsOfGroup, catalogItemId) {
	const counts = new Map();

	for (const trip of tripRowsOfGroup) {
		for (const row of trip.rows) {
			if (row.catalogItemId !== catalogItemId) continue;

			const key = `${row.quantity}|${row.unit}`;
			const entry = counts.get(key) ?? { quantity: row.quantity, unit: row.unit, uses: 0, last: 0 };

			entry.uses += 1;
			entry.last = Math.max(entry.last, toMs(row.createdAt));
			counts.set(key, entry);
		}
	}

	let best = null;

	for (const entry of counts.values()) {
		if (!best || entry.uses > best.uses || (entry.uses === best.uses && entry.last > best.last)) {
			best = entry;
		}
	}

	return best ? { quantity: best.quantity, unit: best.unit } : { quantity: 1, unit: "piece" };
}


/**
 * The suggestions for one group, built from its completed trips.
 *
 * Resolves to { code, modelVersion, suggestions }. `now` is a parameter so a test can pin the moment the
 * features are measured at; the API leaves it at the current time.
 */
async function getSuggestions(groupId, { now = Date.now(), model = MODEL } = {}) {
	const [history, list] = await Promise.all([
		ItemHistory.find({ group: groupId, tripId: { $ne: null }, catalogItemId: { $ne: null } })
			.select("tripId catalogItemId quantity unit addedAt createdAt status")
			.lean(),
		ListItem.find({ group: groupId }).select("catalogItemId").lean(),
	]);

	const trips = tripRows(history);
	const past = trips.filter((trip) => trip.time < now);

	if (past.length < model.minTrips) {
		return { code: NOT_ENOUGH_HISTORY, modelVersion: model.version, suggestions: [] };
	}

	// an item already on the list is not a suggestion
	const onList = new Set(list.map((item) => item.catalogItemId).filter(Boolean));

	const ranked = candidateFeatures(past, now, model.fallbackMedianInterval)
		.filter((candidate) => !onList.has(candidate.catalogItemId))
		.map((candidate) => ({ ...candidate, probability: score(candidate.features, model) }))
		.filter((candidate) => candidate.probability >= model.threshold)
		.sort((a, b) => b.probability - a.probability || compareText(a.catalogItemId, b.catalogItemId))
		.slice(0, model.maxSuggestions);

	const suggestions = [];

	for (const candidate of ranked) {
		const catalogItem = getCatalogItem(candidate.catalogItemId);

		// a suggestion the admin cannot add through POST /items would be a dead end
		if (!catalogItem) continue;

		const sizing = usualSizing(trips, candidate.catalogItemId);

		suggestions.push({
			catalogItemId: candidate.catalogItemId,
			catalogItem,
			probability: Number(candidate.probability.toFixed(4)),
			reason: reasonFor(candidate.features),
			suggestedQuantity: sizing.quantity,
			suggestedUnit: sizing.unit,
		});
	}

	return { code: null, modelVersion: model.version, suggestions };
}


module.exports = {
	getSuggestions,
	candidateFeatures,
	tripRows,
	score,
	reasonFor,
	toMs,
	MODEL,
	NOT_ENOUGH_HISTORY,
};
