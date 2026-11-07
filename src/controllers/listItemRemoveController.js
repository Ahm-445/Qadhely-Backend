const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { getCatalogItem } = require("../services/catalog");


// US 13 — Remove Item from List (SF-42)
// Kept apart from listItemController.js (US 12) so the add-item code is not touched.
// getListItems is the minimal read the app needs to show the items it can remove;
// US 15 (View Items in Shopping List Groups) can extend it.


// same shape as the US 12 add-item response
function toListItemResponse(item) {
	return {
		id: String(item._id),
		groupId: String(item.group),
		catalogItemId: item.catalogItemId ?? null,
		quantity: item.quantity,
		unit: item.unit,
		addedBy: String(item.addedBy),
		customName: item.customName ?? null,
		customImage: item.customImage ?? null,
		customStore: item.customStore ?? null,
		// US 15: the name, image and store the list shows; null for a custom request
		catalogItem: item.catalogItemId ? getCatalogItem(item.catalogItemId) : null,
		createdAt: item.createdAt,
	};
}


// GET /api/groups/:groupId/items
// Every member of the group can read its list, newest first.
const getListItems = async (req, res) => {
	try {

		const { groupId } = req.params;
		const userId = String(req.user.id);

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		if (!group.roleOf(userId)) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		const items = await ListItem.find({ group: group._id }).sort({ createdAt: -1 }).lean();

		return res.status(200).json({
			groupId: String(group._id),
			items: items.map(toListItemResponse),
		});

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to load the list." });
	}
};


// DELETE /api/groups/:groupId/items/:itemId
// US 13 AC-01: the Group Creator or an admin removes an item from the list.
// Regular members and outsiders get 403; an item of another group is "not found".
const removeListItem = async (req, res) => {
	try {

		const { groupId, itemId } = req.params;
		const userId = String(req.user.id);

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
			return res.status(403).json({ error: "Only group admins can remove items." });
		}

		// the group is part of the filter, so an id from another group cannot be removed through this one
		const item = await ListItem.findOneAndDelete({ _id: itemId, group: group._id });

		if (!item) {
			return res.status(404).json({ error: "Item not found on this list." });
		}

		return res.status(200).json({
			message: "Item removed",
			itemId: String(item._id),
		});

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to remove the item." });
	}
};


module.exports = { getListItems, removeListItem };
