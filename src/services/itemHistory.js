const ItemHistory = require("../models/ItemHistory");


// Item history — the only places that write to it.
//
// recordAddition is called right after a list item is created (US 12 add, US 22 replace);
// recordTrip when the admin completes the list. Nothing here throws at the caller: an addition
// that was saved must not fail because its history row could not be written, and the caller of
// recordTrip can rely on the throw to keep the list when the trip was not stored.

function historyRow(item, tripId) {
	return {
		group: item.group,
		tripId,
		catalogItemId: item.catalogItemId ?? null,
		customName: item.customName ?? null,
		customImage: item.customImage ?? null,
		customStore: item.customStore ?? null,
		quantity: item.quantity,
		unit: item.unit,
		addedBy: item.addedBy,
		addedAt: item.createdAt ?? new Date(),
		status: item.status ?? "pending",
	};
}


// an item that was just created on a group's list: recorded with no trip yet
async function recordAddition(item) {
	try {
		await ItemHistory.create(historyRow(item, null));
	}
	catch (err) {
		console.log("[item-history] could not record an addition:", err.message);
	}
}


// the items that were on the list when it was completed: one row each, all under the same trip
async function recordTrip(items, tripId) {
	await ItemHistory.insertMany(items.map((item) => historyRow(item, tripId)));
}


module.exports = { recordAddition, recordTrip };
