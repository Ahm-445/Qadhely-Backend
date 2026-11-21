const mongoose = require("mongoose");

const Group = require("../models/Group");
const { getSuggestions } = require("../services/suggestions");


// GET /api/groups/:groupId/suggestions
// US 23: the items the model expects on the group's next list, with the reason and the usual quantity.
// The same access rule as adding an item: 400 for an invalid id, 404 for a missing group, 403 for a
// non-member and for a member without an admin role.
const getGroupSuggestions = async (req, res) => {
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
			return res.status(403).json({ error: "Only group admins can see suggestions." });
		}

		const { code, modelVersion, suggestions } = await getSuggestions(group._id);

		// 200 either way: an empty tab with a reason is a normal answer, not an error
		return res.status(200).json({
			groupId: String(group._id),
			modelVersion,
			code,
			suggestions,
		});

	}
	catch (err) {
		console.log(err);
		return res.status(500).json({ error: "Failed to build the suggestions." });
	}
};


module.exports = { getGroupSuggestions };
