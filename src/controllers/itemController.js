const mongoose = require("mongoose");

const Group = require("../models/Group");
const Item = require("../models/Item");
const { ITEM_NAME_MAX, UNIT_MAX } = Item;
const { notifyItemRemoved, notifyItemModified } = require("../services/pushNotifications");


// shape sent to the app
function toItemResponse(item) {
	return {
		id: String(item._id),
		groupId: String(item.group),
		name: item.name,
		quantity: item.quantity,
		unit: item.unit,
		addedBy: String(item.addedBy),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}


// loads the group and checks the caller is a member; sends the error response itself
async function loadGroupForMember(req, res) {

	const { groupId } = req.params;

	if (!mongoose.isValidObjectId(groupId)) {
		res.status(400).json({ error: "Invalid group ID." });
		return null;
	}

	const group = await Group.findById(groupId).select("name members");

	if (!group) {
		res.status(404).json({ error: "Group not found." });
		return null;
	}

	if (!group.roleOf(req.user.id)) {
		res.status(403).json({ error: "You are not a member of this group." });
		return null;
	}

	return group;
}


async function loadItem(req, res, group) {

	const { itemId } = req.params;

	if (!mongoose.isValidObjectId(itemId)) {
		res.status(400).json({ error: "Invalid item ID." });
		return null;
	}

	const item = await Item.findOne({ _id: itemId, group: group._id });

	if (!item) {
		res.status(404).json({ error: "Item not found." });
		return null;
	}

	return item;
}


// returns an error message, or null when valid
function validateQuantity(quantity) {
	if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
		return "Quantity must be a number greater than 0.";
	}
	return null;
}

function validateUnit(unit) {
	if (typeof unit !== "string" || !unit.trim()) {
		return "Enter a unit.";
	}
	if (unit.trim().length > UNIT_MAX) {
		return `Unit must be ${UNIT_MAX} characters or less.`;
	}
	return null;
}


// GET /api/groups/:groupId/items
const getItems = async (req, res) => {
	try {

		const group = await loadGroupForMember(req, res);
		if (!group) return;

		const items = await Item.find({ group: group._id }).sort({ createdAt: 1 });

		return res.status(200).json({ groupId: String(group._id), items: items.map(toItemResponse) });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to load items." });
	}
};


// POST /api/groups/:groupId/items
// body: { name: string, quantity?: number, unit?: string }
const addItem = async (req, res) => {
	try {

		const group = await loadGroupForMember(req, res);
		if (!group) return;

		const { name, quantity, unit } = req.body || {};

		if (typeof name !== "string" || !name.trim()) {
			return res.status(400).json({ error: "Enter a name for the item." });
		}

		if (name.trim().length > ITEM_NAME_MAX) {
			return res.status(400).json({ error: `Item name must be ${ITEM_NAME_MAX} characters or less.` });
		}

		const error = (quantity !== undefined && validateQuantity(quantity))
			|| (unit !== undefined && validateUnit(unit));

		if (error) {
			return res.status(400).json({ error });
		}

		const item = await Item.create({
			group: group._id,
			name: name.trim(),
			quantity,
			unit: unit?.trim(),
			addedBy: req.user.id,
		});

		return res.status(201).json({ message: "Item added", item: toItemResponse(item) });

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to add item." });
	}
};


// PATCH /api/groups/:groupId/items/:itemId
// body: { quantity?: number, unit?: string }
// "Item modified" story AC-01: when the quantity or unit changes, the other members get a
// notification naming the item; AC-02: it carries the group id so the app can open the group.
const updateItem = async (req, res) => {
	try {

		const group = await loadGroupForMember(req, res);
		if (!group) return;

		const { quantity, unit } = req.body || {};

		if (quantity === undefined && unit === undefined) {
			return res.status(400).json({ error: "Send a new quantity or unit." });
		}

		const error = (quantity !== undefined && validateQuantity(quantity))
			|| (unit !== undefined && validateUnit(unit));

		if (error) {
			return res.status(400).json({ error });
		}

		const item = await loadItem(req, res, group);
		if (!item) return;

		const previous = { quantity: item.quantity, unit: item.unit };

		if (quantity !== undefined) item.quantity = quantity;
		if (unit !== undefined) item.unit = unit.trim();

		const changed = item.quantity !== previous.quantity || item.unit !== previous.unit;

		if (changed) {
			await item.save();

			// not awaited: members are notified in the background so the response is not delayed
			notifyItemModified(group, req.user.id, item, previous);
		}

		return res.status(200).json({ message: changed ? "Item updated" : "No changes", item: toItemResponse(item) });

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to update item." });
	}
};


// DELETE /api/groups/:groupId/items/:itemId
// "Item removed" story AC-01: the other members get a notification naming the removed item;
// AC-02: it carries the group id so the app can open the group.
const removeItem = async (req, res) => {
	try {

		const group = await loadGroupForMember(req, res);
		if (!group) return;

		const item = await loadItem(req, res, group);
		if (!item) return;

		await item.deleteOne();

		// not awaited: members are notified in the background so the response is not delayed
		notifyItemRemoved(group, req.user.id, item);

		return res.status(200).json({ message: "Item removed", item: toItemResponse(item) });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to remove item." });
	}
};


module.exports = { getItems, addItem, updateItem, removeItem };
