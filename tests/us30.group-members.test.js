// US 30: View Group Members — API tests (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const User = require("../src/models/User");
const Group = require("../src/models/Group");


// small app with only the group routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);


let mongo;

// same token shape as the login response
const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

async function makeUsers(names) {
	return User.insertMany(names.map((handleName, i) => ({
		handleName,
		phoneNumber: `+96655${String(i).padStart(7, "0")}`,
	})));
}

// creator + one admin + one regular member, plus someone outside the group
async function setup() {
	const [creator, admin, member, outsider] = await makeUsers(["Sara", "Omar", "Ali", "Noura"]);
	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: member._id, role: "member" },
			{ user: admin._id, role: "admin" },
		],
	});
	return { creator, admin, member, outsider, group };
}

const getMembers = (groupId, user) => {
	const req = request(app).get(`/api/groups/${groupId}/members`);
	return user ? req.set("Authorization", tokenFor(user)) : req;
};


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us30" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({})]);
});



describe("GET /api/groups/:groupId/members — AC-01 (admins see members and roles)", () => {

	test("the creator sees every member with handle name and role, creator first, then admins, then members", async () => {
		const { creator, group } = await setup();

		const res = await getMembers(group._id, creator);

		expect(res.status).toBe(200);
		expect(res.body.groupId).toBe(String(group._id));
		expect(res.body.members.map((m) => [m.handleName, m.role])).toEqual([
			["Sara", "creator"],
			["Omar", "admin"],
			["Ali", "member"],
		]);
	});

	test("an admin can view the members too", async () => {
		const { admin, group } = await setup();

		const res = await getMembers(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.members).toHaveLength(3);
	});

	test("marks the caller with isMe and returns each member's id and joinedAt", async () => {
		const { creator, admin, group } = await setup();

		const res = await getMembers(group._id, admin);

		const me = res.body.members.find((m) => m.isMe);
		expect(me).toMatchObject({ id: String(admin._id), handleName: "Omar", role: "admin" });
		expect(res.body.members.filter((m) => m.isMe)).toHaveLength(1);
		expect(res.body.members.find((m) => m.id === String(creator._id)).joinedAt).toBeDefined();
	});

	test("does not send phone numbers (NFR-09)", async () => {
		const { creator, group } = await setup();

		const res = await getMembers(group._id, creator);

		for (const m of res.body.members) {
			expect(Object.keys(m).sort()).toEqual(["handleName", "id", "isMe", "joinedAt", "role"]);
		}
		expect(JSON.stringify(res.body)).not.toContain("+966");
	});

	test("members within the same role are sorted by handle name", async () => {
		const { creator, group } = await setup();
		const [zed, bader] = await User.insertMany([
			{ handleName: "Zed", phoneNumber: "+966559000001" },
			{ handleName: "Bader", phoneNumber: "+966559000002" },
		]);
		await Group.updateOne({ _id: group._id }, { $push: { members: { $each: [
			{ user: zed._id, role: "member" },
			{ user: bader._id, role: "member" },
		] } } });

		const res = await getMembers(group._id, creator);

		expect(res.body.members.map((m) => m.handleName)).toEqual(["Sara", "Omar", "Ali", "Bader", "Zed"]);
	});

});



describe("GET /api/groups/:groupId/members — AC-02 (list reflects joins and leaves)", () => {

	test("a user added by the admin appears in the list", async () => {
		const { creator, outsider, group } = await setup();

		const add = await request(app)
			.post(`/api/groups/${group._id}/members`)
			.set("Authorization", tokenFor(creator))
			.send({ userId: String(outsider._id) });
		expect(add.status).toBe(200);

		const res = await getMembers(group._id, creator);
		expect(res.body.members.find((m) => m.handleName === "Noura")).toMatchObject({ role: "member" });
		expect(res.body.members).toHaveLength(4);
	});

	test("a user who joined with an invite link appears in the list", async () => {
		const { creator, outsider, group } = await setup();

		const invite = await request(app)
			.post(`/api/groups/${group._id}/invite`)
			.set("Authorization", tokenFor(creator));
		const token = invite.body.inviteLink.split("/").pop();

		const join = await request(app)
			.post(`/api/groups/join/${token}`)
			.set("Authorization", tokenFor(outsider));
		expect(join.status).toBe(200);

		const res = await getMembers(group._id, creator);
		expect(res.body.members.map((m) => m.handleName)).toContain("Noura");
	});

	test("a user who left no longer appears", async () => {
		const { creator, member, group } = await setup();

		// there is no "leave group" route yet (later story), so remove the member directly
		await Group.updateOne({ _id: group._id }, { $pull: { members: { user: member._id } } });

		const res = await getMembers(group._id, creator);
		expect(res.body.members.map((m) => m.handleName)).toEqual(["Sara", "Omar"]);
	});

	test("a role change is reflected", async () => {
		const { creator, member, group } = await setup();

		await Group.updateOne(
			{ _id: group._id, "members.user": member._id },
			{ $set: { "members.$.role": "admin" } }
		);

		const res = await getMembers(group._id, creator);
		expect(res.body.members.find((m) => m.handleName === "Ali").role).toBe("admin");
	});

	test("members whose account was deleted are left out", async () => {
		const { creator, member, group } = await setup();

		await User.deleteOne({ _id: member._id });

		const res = await getMembers(group._id, creator);
		expect(res.status).toBe(200);
		expect(res.body.members.map((m) => m.handleName)).toEqual(["Sara", "Omar"]);
	});

});



describe("GET /api/groups/:groupId/members — AC-03 and access rules (NFR-10)", () => {

	test("a regular member is refused with 403", async () => {
		const { member, group } = await setup();

		const res = await getMembers(group._id, member);

		expect(res.status).toBe(403);
		expect(res.body.error).toBeDefined();
		expect(res.body.members).toBeUndefined();
	});

	test("a user outside the group is refused with 403", async () => {
		const { outsider, group } = await setup();

		const res = await getMembers(group._id, outsider);

		expect(res.status).toBe(403);
		expect(res.body.members).toBeUndefined();
	});

	test("an unknown group returns 404", async () => {
		const { creator } = await setup();

		const res = await getMembers(new mongoose.Types.ObjectId().toString(), creator);

		expect(res.status).toBe(404);
	});

	test("an invalid group id returns 400", async () => {
		const { creator } = await setup();

		const res = await getMembers("not-an-id", creator);

		expect(res.status).toBe(400);
	});

	test("a missing or invalid token returns 401", async () => {
		const { group } = await setup();

		const r1 = await getMembers(group._id);
		const r2 = await request(app).get(`/api/groups/${group._id}/members`).set("Authorization", "Bearer bad");

		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
	});

});
