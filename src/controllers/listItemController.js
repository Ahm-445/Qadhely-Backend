const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { UNITS, CATALOG_ITEM_ID_PATTERN, CATALOG_ITEM_ID_MAX } = ListItem;
const { getCatalogItem } = require("../services/catalog");


// shape sent to the app
function toListItemResponse(item, groupId) {
	return {
		id: String(item._id),
		groupId: String(groupId),
		catalogItemId: item.catalogItemId ?? null,
		quantity: item.quantity,
		unit: item.unit,
		addedBy: String(item.addedBy),
		customName: item.customName,
		customImage: item.customImage,
		customStore: item.customStore,
		// US 15: the name, image and store the list shows; null for a custom request
		catalogItem: item.catalogItemId ? getCatalogItem(item.catalogItemId) : null,
		createdAt: item.createdAt,
	};
}


// US 12 AC-03 and US 14 AC-04: null when the unit and quantity are valid, otherwise the message
function quantityError(quantity, unit) {
	if (!Object.values(UNITS).includes(unit)) {
		return `Unit must be one of ${Object.values(UNITS).join(", ")}.`;
	}

	if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
		return "Enter a quantity of 0 or more.";
	}

	// a decimal point is allowed only by weight
	if (unit !== UNITS.KG && !Number.isInteger(quantity)) {
		return "Quantity must be a whole number unless the unit is kg.";
	}

	return null;
}


// POST /api/groups/:groupId/items
// body: { catalogItemId: string, quantity: number, unit?: "kg" | "piece" | "box" }
// US 12 AC-01: stores the catalog item on the group's list.
// US 12 AC-02: only the Group Creator and admins can add; everyone else gets 403.
// US 12 AC-03: a whole number unless the unit is kg; the unit is one of the three.
// US 12 AC-04: the group has to exist.
const addListItem = async (req, res) => {
	try {

		const { groupId } = req.params;
		const userId = String(req.user.id);
		const { catalogItemId, quantity, unit = UNITS.PIECE } = req.body || {};

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		// US 12 AC-02: the same rule as the Add Items tab
		const role = group.roleOf(userId);

		if (!role) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (!Group.isAdminRole(role)) {
			return res.status(403).json({ error: "Only group admins can add items." });
		}

		// the catalog teammate owns the catalog; here the id only has to be well formed
		const catalogId = typeof catalogItemId === "string" ? catalogItemId.trim() : "";

		if (!CATALOG_ITEM_ID_PATTERN.test(catalogId) || catalogId.length > CATALOG_ITEM_ID_MAX) {
			return res.status(400).json({ error: "A valid catalog item is required." });
		}

		const invalid = quantityError(quantity, unit);

		if (invalid) {
			return res.status(400).json({ error: invalid });
		}

		const item = await ListItem.create({
			group: group._id,
			catalogItemId: catalogId,
			quantity,
			unit,
			addedBy: userId,
		});

		return res.status(201).json({
			message: "Item added",
			item: toListItemResponse(item, group._id),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to add the item." });
	}
};


// PATCH /api/groups/:groupId/items/:itemId
// body: { quantity: number, unit: "kg" | "piece" | "box" }
// US 14 AC-02: saves the new quantity and unit of an item on the group's list.
// US 14 AC-04: an invalid quantity or unit gets 400 and changes nothing.
// Only the Group Creator and admins can modify (NFR-10); an item of another group is "not found".
const updateListItem = async (req, res) => {
	try {

		const { groupId, itemId } = req.params;
		const userId = String(req.user.id);
		const { quantity, unit } = req.body || {};

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		if (!mongoose.isValidObjectId(itemId)) {
			return res.status(400).json({ error: "Invalid item ID." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		const role = group.roleOf(userId);

		if (!role) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (!Group.isAdminRole(role)) {
			return res.status(403).json({ error: "Only group admins can modify items." });
		}

		const invalid = quantityError(quantity, unit);

		if (invalid) {
			return res.status(400).json({ error: invalid });
		}

		// the group is part of the filter, so an id from another group cannot be modified through this one
		const item = await ListItem.findOne({ _id: itemId, group: group._id });

		if (!item) {
			return res.status(404).json({ error: "Item not found on this list." });
		}

		// save() rather than an update query, so the model's quantity-by-unit validator still runs
		item.quantity = quantity;
		item.unit = unit;
		await item.save();

		return res.status(200).json({
			message: "Item updated",
			item: toListItemResponse(item, group._id),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to update the item." });
	}
};


module.exports = { addListItem, updateListItem };
