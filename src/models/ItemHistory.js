const mongoose = require("mongoose");

const ListItem = require("./ListItem");

const { UNITS, CATALOG_ITEM_ID_PATTERN, CATALOG_ITEM_ID_MAX, CUSTOM_NAME_MAX, ITEM_STATUSES } = ListItem;


// Item history — the append-only record the AI suggestions read.
//
// Two kinds of row, never updated and never deleted (except with the group itself):
//  - an addition: written the moment an item is created on a group's list (US 12 add, US 22
//    replace). tripId is null, because the trip it belongs to does not exist yet.
//  - a trip row: written when the admin completes the list, one per item that was on it, all
//    sharing the tripId of that trip. It carries the quantity, unit and status the item ended
//    with, so an edit made after the addition is what the history keeps.
//
// An item removed from the list keeps its addition row with no trip: it was added and never
// bought. The AI suggestions read the trip rows for frequency and recency, so a trip row is a
// purchase and an addition row is not.
//
// The catalog item is stored by id, like ListItem, so a row costs a few dozen bytes.

const itemHistorySchema = new mongoose.Schema({

	group: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "Group",
		required: true,
		index: true
	},

	// the completed trip this row belongs to; null on an addition whose trip never completed
	tripId: {
		type: mongoose.Schema.Types.ObjectId,
		default: null
	},

	catalogItemId: {
		type: String,
		trim: true,
		maxlength: [CATALOG_ITEM_ID_MAX, `Catalog item id must be ${CATALOG_ITEM_ID_MAX} characters or less`],
		required: [function () { return !this.customName; }, "A catalog item id is required"],
		match: [CATALOG_ITEM_ID_PATTERN, "Invalid catalog item id"]
	},

	// custom request only, mirroring ListItem: no catalogItemId, its own display fields
	customName: {
		type: String,
		trim: true,
		maxlength: [CUSTOM_NAME_MAX, `Item name must be ${CUSTOM_NAME_MAX} characters or less`]
	},

	customImage: {
		type: String,
		trim: true
	},

	customStore: {
		type: String,
		trim: true
	},

	quantity: {
		type: Number,
		required: [true, "Quantity is required"],
		min: [0, "Quantity cannot be negative"]
	},

	unit: {
		type: String,
		enum: {
			values: Object.values(UNITS),
			message: `Unit must be one of ${Object.values(UNITS).join(", ")}`
		},
		default: UNITS.PIECE
	},

	addedBy: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
		required: true
	},

	// when the item was added to the list, not when the row was written
	addedAt: {
		type: Date,
		required: true,
		default: Date.now
	},

	// US 16 status at the time of the row: "found" is a purchase, "notFound" is not
	status: {
		type: String,
		enum: {
			values: Object.values(ITEM_STATUSES),
			message: `Status must be one of ${Object.values(ITEM_STATUSES).join(", ")}`
		},
		default: ITEM_STATUSES.PENDING
	},

}, { timestamps: true });


// a group's trips, and one trip's rows
itemHistorySchema.index({ group: 1, tripId: 1 });

// the AI's query: how often and how recently a group bought one catalog item
itemHistorySchema.index({ group: 1, catalogItemId: 1, addedAt: -1 });


const ItemHistory = mongoose.models.ItemHistory || mongoose.model("ItemHistory", itemHistorySchema);

module.exports = ItemHistory;
