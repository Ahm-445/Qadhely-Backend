const mongoose = require("mongoose");

const Group = require("../models/Group");
const User = require("../models/User");

const { ROLES, GROUP_NAME_MAX, MAX_INITIAL_MEMBERS } = Group;


// shape sent to the app
function toGroupResponse(group, userId) {
	return {
		id: String(group._id),
		name: group.name,
		createdBy: String(group.createdBy),
		myRole: group.roleOf(userId),
		memberCount: group.members.length,
		createdAt: group.createdAt,
		updatedAt: group.updatedAt,
	};
}


// POST /api/groups
// body: { name: string, memberIds?: string[] }   (0 to 10 registered users)
// US 05 AC-02: creates the group with a unique id and makes the caller the Group Creator
const createGroup = async (req, res) => {
	try {

		const userId = String(req.user.id);
		const { name, memberIds = [] } = req.body || {};


		// validate name (SF-16)
		if (typeof name !== "string" || !name.trim()) {
			return res.status(400).json({ error: "Enter a name for the group." });
		}

		const groupName = name.trim();

		if (groupName.length > GROUP_NAME_MAX) {
			return res.status(400).json({ error: `Group name must be ${GROUP_NAME_MAX} characters or less.` });
		}


		// validate members (SF-17)
		if (!Array.isArray(memberIds)) {
			return res.status(400).json({ error: "memberIds must be a list." });
		}

		// remove duplicates and the creator's own id
		const ids = [...new Set(memberIds.map(String))].filter((id) => id !== userId);

		if (ids.length > MAX_INITIAL_MEMBERS) {
			return res.status(400).json({ error: `You can add up to ${MAX_INITIAL_MEMBERS} members.` });
		}

		if (ids.some((id) => !mongoose.isValidObjectId(id))) {
			return res.status(400).json({ error: "Invalid member." });
		}

		if (ids.length > 0) {
			const found = await User.countDocuments({ _id: { $in: ids } });

			if (found !== ids.length) {
				return res.status(400).json({ error: "Some selected contacts are not registered with Qadhely." });
			}
		}


		// create the group (SF-18, SF-19)
		const group = await Group.create({
			name: groupName,
			createdBy: userId,
			members: [
				{ user: userId, role: ROLES.CREATOR },
				...ids.map((id) => ({ user: id, role: ROLES.MEMBER })),
			],
		});

		return res.status(201).json({
			message: "Group created",
			group: toGroupResponse(group, userId),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to create group" });
	}
};


// GET /api/groups  ->  { created: [...], shared: [...] }
// US 05 AC-03 / SF-20: the two Home page categories (US 07 builds on this)
const getMyGroups = async (req, res) => {
	try {

		const userId = String(req.user.id);

		const groups = await Group.find({ "members.user": userId }).sort({ updatedAt: -1 });

		const created = [];
		const shared = [];

		for (const group of groups) {
			const item = toGroupResponse(group, userId);

			if (String(group.createdBy) === userId) {
				created.push(item);
			}
			else {
				shared.push(item);
			}
		}

		return res.status(200).json({ created, shared });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to load groups" });
	}
};


module.exports = { createGroup, getMyGroups };
