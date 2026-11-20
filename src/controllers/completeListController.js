const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { recordTrip } = require("../services/itemHistory");

const { ITEM_STATUSES } = ListItem;


// "Complete list" — the admin closes the active list.
//
// POST /api/groups/:groupId/complete-list
//
// Everything on the list is stored in the item history under one tripId (the trip is invisible to
// the admin) and the list is then cleared. Only the Group Creator and admins may complete it, and
// only once every item is found or not found: a replaced item counts as resolved, because it was
// marked not found before it was replaced.
const completeList = async (req, res) => {
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

		const role = group.roleOf(userId);

		if (!role) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (!Group.isAdminRole(role)) {
			return res.status(403).json({ error: "Only group admins can complete the list." });
		}

		const items = await ListItem.find({ group: group._id }).sort({ createdAt: -1 }).lean();

		if (items.length === 0) {
			return res.status(400).json({ error: "There is nothing to complete.", code: "LIST_EMPTY" });
		}

		// rows saved before US 16 have no status and read as pending
		const pending = items.some((item) => (item.status ?? ITEM_STATUSES.PENDING) === ITEM_STATUSES.PENDING);

		if (pending) {
			return res.status(409).json({
				error: "Mark every item as found or not found before completing the list.",
				code: "LIST_NOT_RESOLVED",
			});
		}

		const tripId = new mongoose.Types.ObjectId();

		// the trip is stored first: if it cannot be, the list stays as it was
		await recordTrip(items, tripId);

		// clear only the items that went into the trip, so an item added meanwhile stays on the list
		await ListItem.deleteMany({ group: group._id, _id: { $in: items.map((item) => item._id) } });

		return res.status(200).json({
			message: "List completed",
			tripId: String(tripId),
			itemCount: items.length,
		});

	}
	catch (err) {
		console.log(err);
		return res.status(500).json({ error: "Failed to complete the list." });
	}
};


module.exports = { completeList };
