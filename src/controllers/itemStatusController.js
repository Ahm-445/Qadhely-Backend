const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { getCatalogItem } = require("../services/catalog");
const { notifyListCompleted, resetListCompleted } = require("../services/pushNotifications");

const { ITEM_STATUSES, REPLACEMENT_TEXT_MAX } = ListItem;


// US 16 — In-Store Item Status Tracking (SF-45, SF-52, SF-53)
//
// PATCH /api/groups/:groupId/items/:itemId/status
// body: { status: "found" | "notFound" | "pending", replacementText?: string }
//
// AC-01: any group member marks an item as found.
// AC-02: any group member marks an item as not found, optionally with text recommending a replacement.
// AC-03: the replacement text is saved on the not-found item.
// The status is stored on the item, so every member sees it the next time the list loads
// (the app re-reads the list every few seconds while it is open).
// "pending" undoes a mark. Replacement text is kept only while the item is not found.


const SETTABLE = [ITEM_STATUSES.FOUND, ITEM_STATUSES.NOT_FOUND, ITEM_STATUSES.PENDING];


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
		catalogItem: item.catalogItemId ? getCatalogItem(item.catalogItemId) : null,
		createdAt: item.createdAt,
		...ListItem.statusFields(item),
	};
}


const setItemStatus = async (req, res) => {
	try {

		const { groupId, itemId } = req.params;
		const userId = String(req.user.id);
		const { status, replacementText } = req.body || {};

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		if (!mongoose.isValidObjectId(itemId)) {
			return res.status(400).json({ error: "Invalid item ID." });
		}

		if (!SETTABLE.includes(status)) {
			return res.status(400).json({ error: `Status must be one of ${SETTABLE.join(", ")}.` });
		}

		if (replacementText !== undefined && replacementText !== null && typeof replacementText !== "string") {
			return res.status(400).json({ error: "Replacement text must be text." });
		}

		const text = typeof replacementText === "string" ? replacementText.trim() : "";

		if (text.length > REPLACEMENT_TEXT_MAX) {
			return res.status(400).json({ error: `Replacement text must be ${REPLACEMENT_TEXT_MAX} characters or less.` });
		}

		if (text && status !== ITEM_STATUSES.NOT_FOUND) {
			return res.status(400).json({ error: "Replacement text can only be added to an item that is not found." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		// SF-52: every member can mark items, not only admins
		if (!group.roleOf(userId)) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		// US 21: only a change TO found can complete the list, not marking a found item found again
		const wasFound = status === ITEM_STATUSES.FOUND
			&& Boolean(await ListItem.exists({ _id: itemId, group: group._id, status: ITEM_STATUSES.FOUND }).catch(() => null));

		// only items whose status a member can still change (US 22 adds a final "replaced" state)
		const item = await ListItem.findOneAndUpdate(
			{ _id: itemId, group: group._id, status: { $in: SETTABLE.concat([null]) } },
			{
				$set: {
					status,
					replacementText: status === ITEM_STATUSES.NOT_FOUND && text ? text : null,
					statusUpdatedBy: userId,
					statusUpdatedAt: new Date(),
				}
			},
			{ returnDocument: "after", runValidators: true }
		);

		if (!item) {
			const exists = await ListItem.exists({ _id: itemId, group: group._id });
			if (exists) {
				return res.status(409).json({ error: "This item can no longer be changed." });
			}
			return res.status(404).json({ error: "Item not found on this list." });
		}

		// US 21: tell the admins when this completed the list; any other mark reopens it. Neither can fail the update.
		if (status === ITEM_STATUSES.FOUND) {
			if (!wasFound) notifyListCompleted(group._id);
		}
		else {
			await resetListCompleted(group._id);
		}

		return res.status(200).json({
			message: "Item status updated",
			item: toListItemResponse(item),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		return res.status(500).json({ error: "Failed to update the item status." });
	}
};


module.exports = { setItemStatus };
