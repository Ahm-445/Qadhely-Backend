const mongoose = require("mongoose");

const Group = require("../models/Group");
const User = require("../models/User");
const crypto = require("crypto");
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

const addGroupMember = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { userId } = req.body || {};
    const requesterId = String(req.user.id);

    if (!mongoose.isValidObjectId(groupId)) {
      return res.status(400).json({ error: "Invalid group ID." });
    }

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: "Invalid user ID." });
    }

    const group = await Group.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const requesterRole = group.roleOf(requesterId);

    if (!Group.isAdminRole(requesterRole)) {
      return res.status(403).json({
        error: "Only the group admin can add members.",
      });
    }

    const userExists = await User.exists({ _id: userId });

    if (!userExists) {
      return res.status(400).json({
        error: "This contact is not registered with Qadhely.",
      });
    }

    if (group.members.some((member) => String(member.user) === String(userId))) {
      return res.status(409).json({
        error: "This user is already a group member.",
      });
    }

    group.members.push({
      user: userId,
      role: ROLES.MEMBER,
    });

    await group.save();

    return res.status(200).json({
      message: "Member added successfully.",
      group: toGroupResponse(group, requesterId),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Failed to add group member." });
  }
};

const generateGroupInvite = async (req, res) => {
  try {
    const { groupId } = req.params;
    const requesterId = String(req.user.id);

    if (!mongoose.isValidObjectId(groupId)) {
      return res.status(400).json({ error: "Invalid group ID." });
    }

    const group = await Group.findById(groupId);

    if (!group) {
      return res.status(404).json({ error: "Group not found." });
    }

    const requesterRole = group.roleOf(requesterId);

    if (!Group.isAdminRole(requesterRole)) {
      return res.status(403).json({
        error: "Only the group admin can generate an invite link.",
      });
    }

    if (!group.inviteToken) {
      group.inviteToken = crypto.randomBytes(24).toString("hex");
      await group.save();
    }

    return res.status(200).json({
      inviteLink: `/api/groups/join/${group.inviteToken}`,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({ error: "Failed to generate invite link." });
  }
};

const joinGroupByInvite = async (req, res) => {
  try {
    const { inviteToken } = req.params;
    const userId = String(req.user.id);

    const group = await Group.findOne({ inviteToken });

    if (!group) {
      return res.status(404).json({
        error: "Invalid or expired invite link.",
      });
    }

    const alreadyMember = group.members.some(
      (member) => String(member.user) === userId
    );

    if (alreadyMember) {
      return res.status(200).json({
        message: "You are already a member of this group.",
        group: toGroupResponse(group, userId),
      });
    }

    group.members.push({
      user: userId,
      role: ROLES.MEMBER,
    });

    await group.save();

    return res.status(200).json({
      message: "Joined group successfully.",
      group: toGroupResponse(group, userId),
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      error: "Failed to join group.",
    });
  }
};

// US 30 — order of the members list: creator, then admins, then members
const ROLE_ORDER = { [ROLES.CREATOR]: 0, [ROLES.ADMIN]: 1, [ROLES.MEMBER]: 2 };


// GET /api/groups/:groupId/members
// US 30 (SF-25): the group's current members with their handle name and role.
// AC-01: only the Group Creator and admins can see it; AC-03 / NFR-10: anyone else gets 403.
// AC-02: read from the database on every request, so joins and leaves show up right away.
const getGroupMembers = async (req, res) => {
	try {

		const { groupId } = req.params;
		const requesterId = String(req.user.id);

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		// check the caller's role on the stored ids (before looking up names)
		const requesterRole = group.roleOf(requesterId);

		if (!requesterRole) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (!Group.isAdminRole(requesterRole)) {
			return res.status(403).json({ error: "Only group admins can view the members." });
		}

		// handle names only; phone numbers are not sent (NFR-09)
		const users = await User.find({ _id: { $in: group.members.map((m) => m.user) } })
			.select("handleName")
			.lean();

		const nameById = new Map(users.map((u) => [String(u._id), u.handleName]));

		const members = group.members
			.filter((m) => nameById.has(String(m.user)))		// skip deleted accounts
			.map((m) => ({
				id: String(m.user),
				handleName: nameById.get(String(m.user)),
				role: m.role,
				joinedAt: m.joinedAt,
				isMe: String(m.user) === requesterId,
			}))
			.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.handleName.localeCompare(b.handleName));

		return res.status(200).json({ groupId: String(group._id), members });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to load group members." });
	}
};


module.exports = { createGroup, getMyGroups, addGroupMember, generateGroupInvite, joinGroupByInvite, getGroupMembers };
