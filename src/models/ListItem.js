const mongoose = require("mongoose");


// US 12 — one row on a group's shopping list.
//
// The catalog item is stored by id ("tamimi-137805"), not copied. The catalog stays the single
// source of truth for the name, the image and the store, so a row costs a few dozen bytes and a
// renamed or re-priced catalog item is picked up everywhere at once.
//
// A custom request (an item that is not in the catalog) has no catalogItemId and carries its own
// display fields instead. Rows for catalog items leave those empty, so the feature costs nothing
// for the common case.

const UNITS = Object.freeze({
	KG: "kg",
	PIECE: "piece",
	BOX: "box",
});

const CATALOG_ITEM_ID_MAX = 64;
const CUSTOM_NAME_MAX = 100;

// a catalog id is a store slug and a number, e.g. "tamimi-137805"
const CATALOG_ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;


const listItemSchema = new mongoose.Schema({

	group: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "Group",
		required: true,
		index: true
	},

	// the catalog teammate's id; absent only for a custom request
	catalogItemId: {
		type: String,
		trim: true,
		maxlength: [CATALOG_ITEM_ID_MAX, `Catalog item id must be ${CATALOG_ITEM_ID_MAX} characters or less`],
		required: [function () { return !this.customName; }, "A catalog item id is required"],
		match: [CATALOG_ITEM_ID_PATTERN, "Invalid catalog item id"]
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

	// custom request only: filled in when catalogItemId is absent
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

}, { timestamps: true });


// a decimal quantity only makes sense by weight (US 12 AC-03)
listItemSchema.path("quantity").validate(function (value) {
	return this.unit === UNITS.KG || Number.isInteger(value);
}, "Quantity must be a whole number unless the unit is kg");


// the list view reads one group's rows, newest first
listItemSchema.index({ group: 1, createdAt: -1 });


const ListItem = mongoose.models.ListItem || mongoose.model("ListItem", listItemSchema);

module.exports = ListItem;
module.exports.UNITS = UNITS;
module.exports.CATALOG_ITEM_ID_PATTERN = CATALOG_ITEM_ID_PATTERN;
module.exports.CATALOG_ITEM_ID_MAX = CATALOG_ITEM_ID_MAX;
module.exports.CUSTOM_NAME_MAX = CUSTOM_NAME_MAX;
