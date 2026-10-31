const mongoose = require("mongoose");


// An item on a group's shopping list.
// Each group has one list, so items point straight at the group.

const ITEM_NAME_MAX = 100;
const UNIT_MAX = 20;


const itemSchema = new mongoose.Schema({

	group: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "Group",
		required: true,
		index: true
	},

	name: {
		type: String,
		required: [true, "Item name is required"],
		trim: true,
		maxlength: [ITEM_NAME_MAX, `Item name must be ${ITEM_NAME_MAX} characters or less`]
	},

	quantity: {
		type: Number,
		default: 1,
		min: [0.01, "Quantity must be greater than 0"]
	},

	// free text so the app can use "pcs", "kg", "L", "box", ...
	unit: {
		type: String,
		trim: true,
		default: "pcs",
		maxlength: [UNIT_MAX, `Unit must be ${UNIT_MAX} characters or less`]
	},

	addedBy: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
		required: true
	},

}, {timestamps: true});


const Item = mongoose.models.Item || mongoose.model("Item", itemSchema);

module.exports = Item;
module.exports.ITEM_NAME_MAX = ITEM_NAME_MAX;
module.exports.UNIT_MAX = UNIT_MAX;
