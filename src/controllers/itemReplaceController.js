const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { quantityError, toListItemResponse } = require("./listItemController");
const { getCatalogItem } = require("../services/catalog");
const { recordAddition } = require("../services/itemHistory");

const { UNITS, ITEM_STATUSES } = ListItem;


// US 22 — Replacement Item Resolution (SF-54, SF-55, SF-56)
//
// POST /api/groups/:groupId/items/:itemId/replace
// body: { catalogItemId: string, quantity: number, unit?: "kg" | "piece" | "box" }
//
// AC-03: the Group Creator or an admin replaces a not-found item with an item picked from the catalog.
// The picked item is added to the list as a new, pending item. The old item stays on the list with
// status "replaced" (shown crossed out at the end for everyone) and points to its replacement.
// Only a not-found item can be replaced, and only once.
const replaceListItem = async (req, res) => {
	try {

		const { groupId, itemId } = req.params;
		const userId = String(req.user.id);
		const { catalogItemId, quantity, unit = UNITS.PIECE } = req.body || {};

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
			return res.status(403).json({ error: "Only group admins can replace items." });
		}

		const catalogId = typeof catalogItemId === "string" ? catalogItemId.trim() : "";

		// the replacement must be a real catalog item (it was picked from the catalog search)
		if (!getCatalogItem(catalogId)) {
			return res.status(400).json({ error: "Pick a replacement item from the catalog." });
		}

		const invalid = quantityError(quantity, unit);

		if (invalid) {
			return res.status(400).json({ error: invalid });
		}

		const old = await ListItem.findOne({ _id: itemId, group: group._id });

		if (!old) {
			return res.status(404).json({ error: "Item not found on this list." });
		}

		if (old.status !== ITEM_STATUSES.NOT_FOUND) {
			return res.status(409).json({
				error: old.status === ITEM_STATUSES.REPLACED
					? "This item has already been replaced."
					: "Only an item marked as not found can be replaced.",
			});
		}

		const replacementId = new mongoose.Types.ObjectId();

		// claim the old item first, so two admins can't replace it at the same time
		const claimed = await ListItem.findOneAndUpdate(
			{ _id: old._id, status: ITEM_STATUSES.NOT_FOUND },
			{
				$set: {
					status: ITEM_STATUSES.REPLACED,
					replacedBy: replacementId,
					statusUpdatedBy: userId,
					statusUpdatedAt: new Date(),
				}
			},
			{ returnDocument: "after" }
		);

		if (!claimed) {
			return res.status(409).json({ error: "This item has already been replaced." });
		}

		let replacement;

		try {
			replacement = await ListItem.create({
				_id: replacementId,
				group: group._id,
				catalogItemId: catalogId,
				quantity,
				unit,
				addedBy: userId,
				replacementFor: old._id,
			});
		}
		catch (err) {
			// put the old item back as it was, so the admin can try again
			await ListItem.updateOne(
				{ _id: old._id, replacedBy: replacementId },
				{ $set: { status: ITEM_STATUSES.NOT_FOUND, replacedBy: null, statusUpdatedBy: old.statusUpdatedBy, statusUpdatedAt: old.statusUpdatedAt } }
			);
			throw err;
		}

		// a replacement is a new item on the list, so the history records it like any addition
		await recordAddition(replacement);

		return res.status(201).json({
			message: "Item replaced",
			item: toListItemResponse(replacement, group._id),
			replaced: toListItemResponse(claimed, group._id),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		return res.status(500).json({ error: "Failed to replace the item." });
	}
};


module.exports = { replaceListItem };
