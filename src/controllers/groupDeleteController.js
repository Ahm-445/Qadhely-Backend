const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const ItemHistory = require("../models/ItemHistory");

const { ROLES } = Group;


// US 08 — Deleting Shopping List Groups (SF-16, SF-17)
//
// DELETE /api/groups/:groupId   body: { confirmed: true }
// AC-01: only the Group Creator can delete the group. The group document is removed, so every
//        member loses it from their Home list and nobody is a member any more; its shopping
//        list items are deleted with it.
// AC-02: the app must have shown the irreversible warning and the creator must have accepted
//        it; the request is refused without confirmed: true.
const deleteGroup = async (req, res) => {
	try {

		const { groupId } = req.params;
		const userId = String(req.user.id);

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		if (!req.body || req.body.confirmed !== true) {
			return res.status(400).json({
				error: "Confirm that you want to permanently delete this group.",
				code: "CONFIRMATION_REQUIRED",
			});
		}

		const group = await Group.findById(groupId).select("members createdBy");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		const role = group.roleOf(userId);

		if (!role) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (role !== ROLES.CREATOR) {
			return res.status(403).json({ error: "Only the Group Creator can delete this group." });
		}

		// delete the group only if it still belongs to this creator (guards a parallel hand-over)
		const deleted = await Group.findOneAndDelete({ _id: group._id, members: { $elemMatch: { user: group.members.find((m) => String(m.user) === userId).user, role: ROLES.CREATOR } } });

		if (!deleted) {
			return res.status(404).json({ error: "Group not found." });
		}

		await Promise.all([
			ListItem.deleteMany({ group: group._id }),
			ItemHistory.deleteMany({ group: group._id }),
		]);

		return res.status(200).json({
			message: "Group deleted",
			groupId: String(group._id),
		});

	}
	catch (err) {
		console.log(err);
		return res.status(500).json({ error: "Failed to delete the group." });
	}
};


module.exports = { deleteGroup };
