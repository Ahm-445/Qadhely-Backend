const mongoose = require("mongoose");


// US 05 — Shopping list group
// SF-18: the MongoDB _id is the group's unique identifier
// SF-19: the user who creates the group gets the "creator" role (which includes admin privileges)

const ROLES = Object.freeze({
	CREATOR: "creator",
	ADMIN: "admin",
	MEMBER: "member",
});

const GROUP_NAME_MAX = 50;
const MAX_INITIAL_MEMBERS = 10; // SF-17: 0 to 10 members when creating (creator not counted)


const memberSchema = new mongoose.Schema({

	user: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
		required: true
	},

	role: {
		type: String,
		enum: Object.values(ROLES),
		default: ROLES.MEMBER
	},

	joinedAt: {
		type: Date,
		default: Date.now
	},

}, {_id: false});


const groupSchema = new mongoose.Schema({

	name: {
		type: String,
		required: [true, "Group name is required"],
		trim: true,
		maxlength: [GROUP_NAME_MAX, `Group name must be ${GROUP_NAME_MAX} characters or less`]
	},

	createdBy: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
		required: true,
		index: true
	},

	members: {
		type: [memberSchema],
		default: []
	},

}, {timestamps: true});


// find "all groups I belong to" quickly (Home page, US 07)
groupSchema.index({ "members.user": 1 });


// returns "creator" | "admin" | "member" | null
groupSchema.methods.roleOf = function (userId) {
	const member = this.members.find((m) => String(m.user) === String(userId));
	return member ? member.role : null;
};

// creator and admin both have admin privileges (used by US 06 and later)
groupSchema.statics.isAdminRole = (role) => role === ROLES.CREATOR || role === ROLES.ADMIN;


const Group = mongoose.models.Group || mongoose.model("Group", groupSchema);

module.exports = Group;
module.exports.ROLES = ROLES;
module.exports.GROUP_NAME_MAX = GROUP_NAME_MAX;
module.exports.MAX_INITIAL_MEMBERS = MAX_INITIAL_MEMBERS;
