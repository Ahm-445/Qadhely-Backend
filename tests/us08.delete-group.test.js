// US 08: Deleting Shopping List Groups — API tests (Jest + Supertest)
// DELETE /api/groups/:groupId  { confirmed: true }
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
const ListItem = require("../src/models/ListItem");


const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);


let mongo;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

async function makeUsers(names) {
	return Promise.all(names.map((handleName, i) =>
		User.create({ handleName, phoneNumber: `+96655${String(i + 1).padStart(7, "0")}` })
	));
}

// G1: Sara (creator), Omar (admin), Ali (member); Noura is outside the group
async function setup() {
	const [creator, admin, member, outsider] = await makeUsers(["Sara", "Omar", "Ali", "Noura"]);
	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
			{ user: member._id, role: "member" },
		],
	});
	return { creator, admin, member, outsider, group };
}

const addItem = (group, user, name = "Milk") =>
	ListItem.create({ group: group._id, customName: name, quantity: 1, unit: "piece", addedBy: user._id });

// sends { confirmed: true } unless a body (or no body at all) is given
const deleteGroup = (groupId, user, ...body) => {
	const req = request(app).delete(`/api/groups/${groupId}`);
	if (user) req.set("Authorization", tokenFor(user));
	if (body.length === 0) return req.send({ confirmed: true });
	return body[0] === undefined ? req : req.send(body[0]);
};

const myGroups = (user) => request(app).get("/api/groups").set("Authorization", tokenFor(user));


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us08" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});


describe("DELETE /api/groups/:groupId — AC-01 (the creator deletes the group)", () => {

	test("the Group Creator deletes the group and gets 200", async () => {
		const { creator, group } = await setup();

		const res = await deleteGroup(group._id, creator);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ message: "Group deleted", groupId: String(group._id) });
		expect(await Group.findById(group._id)).toBeNull();
	});

	test("the group is no longer visible to any member on Home", async () => {
		const { creator, admin, member, group } = await setup();

		await deleteGroup(group._id, creator);

		for (const user of [creator, admin, member]) {
			const res = await myGroups(user);
			expect(res.status).toBe(200);
			expect([...res.body.created, ...res.body.shared].map((g) => g.id)).not.toContain(String(group._id));
		}
	});

	test("all members are removed: no group lists any of them for this id", async () => {
		const { creator, admin, member, group } = await setup();

		await deleteGroup(group._id, creator);

		expect(await Group.countDocuments({ _id: group._id })).toBe(0);
		for (const user of [creator, admin, member]) {
			expect(await Group.countDocuments({ "members.user": user._id, _id: group._id })).toBe(0);
		}
	});

	test("the group's shopping list items are deleted with it", async () => {
		const { creator, admin, group } = await setup();
		await addItem(group, creator, "Milk");
		await addItem(group, admin, "Eggs");

		await deleteGroup(group._id, creator);

		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("other groups and their lists are untouched", async () => {
		const { creator, member, group } = await setup();
		const other = await Group.create({ name: "Work snacks", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }, { user: member._id, role: "member" }] });
		await addItem(other, creator, "Coffee");

		await deleteGroup(group._id, creator);

		expect(await Group.findById(other._id)).not.toBeNull();
		expect(await ListItem.countDocuments({ group: other._id })).toBe(1);
	});

	test("the users' accounts are not deleted", async () => {
		const { creator, group } = await setup();

		await deleteGroup(group._id, creator);

		expect(await User.countDocuments()).toBe(4);
	});

});


describe("DELETE /api/groups/:groupId — AC-02 (confirmation)", () => {

	test.each([
		["no body", undefined],
		["an empty body", {}],
		["confirmed: false", { confirmed: false }],
		["confirmed as a string", { confirmed: "true" }],
	])("%s is refused with 400 CONFIRMATION_REQUIRED and the group stays", async (_label, body) => {
		const { creator, group } = await setup();

		const res = await deleteGroup(group._id, creator, body);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
		expect(await Group.findById(group._id)).not.toBeNull();
	});

});


describe("DELETE /api/groups/:groupId — who may delete", () => {

	test("an admin gets 403 and the group stays", async () => {
		const { admin, group } = await setup();

		const res = await deleteGroup(group._id, admin);

		expect(res.status).toBe(403);
		expect(res.body.error).toBe("Only the Group Creator can delete this group.");
		expect(await Group.findById(group._id)).not.toBeNull();
	});

	test("a regular member gets 403 and the group stays", async () => {
		const { member, group } = await setup();

		const res = await deleteGroup(group._id, member);

		expect(res.status).toBe(403);
		expect(await Group.findById(group._id)).not.toBeNull();
	});

	test("someone outside the group gets 403 and the group stays", async () => {
		const { outsider, group } = await setup();

		const res = await deleteGroup(group._id, outsider);

		expect(res.status).toBe(403);
		expect(await Group.findById(group._id)).not.toBeNull();
	});

	test("a request without a token gets 401", async () => {
		const { group } = await setup();

		const res = await deleteGroup(group._id, null);

		expect(res.status).toBe(401);
		expect(await Group.findById(group._id)).not.toBeNull();
	});

	test("a failed delete leaves the list items in place", async () => {
		const { member, group } = await setup();
		await addItem(group, member);

		await deleteGroup(group._id, member);

		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

});


describe("DELETE /api/groups/:groupId — bad requests", () => {

	test("an unknown group gets 404", async () => {
		const { creator } = await setup();

		const res = await deleteGroup(new mongoose.Types.ObjectId(), creator);

		expect(res.status).toBe(404);
	});

	test("deleting the same group twice gets 404 the second time", async () => {
		const { creator, group } = await setup();

		await deleteGroup(group._id, creator);
		const res = await deleteGroup(group._id, creator);

		expect(res.status).toBe(404);
	});

	test("a group id that is not an object id gets 400", async () => {
		const { creator } = await setup();

		const res = await deleteGroup("not-an-id", creator);

		expect(res.status).toBe(400);
	});

});
