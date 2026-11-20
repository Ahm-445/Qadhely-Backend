// US 22: Replacement Item Resolution — API tests (Jest + Supertest)
// POST /api/groups/:groupId/items/:itemId/replace  { catalogItemId, quantity, unit }
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


// real ids from data/catalog.json
const LOW_FAT_MILK = "tamimi-1196";
const FULL_FAT_MILK = "tamimi-154850";

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

// G1: Sara (creator), Omar (admin), Ali (member); Noura is outside. One item is not found.
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
	const notFound = await ListItem.create({
		group: group._id, catalogItemId: FULL_FAT_MILK, quantity: 2, unit: "piece", addedBy: creator._id,
		status: "notFound", replacementText: "Low fat milk", statusUpdatedBy: member._id, statusUpdatedAt: new Date(),
	});
	return { creator, admin, member, outsider, group, notFound };
}

const replace = (groupId, itemId, user, body = { catalogItemId: LOW_FAT_MILK, quantity: 3, unit: "piece" }) => {
	const req = request(app).post(`/api/groups/${groupId}/items/${itemId}/replace`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send(body);
};

const listItems = (groupId, user) => request(app).get(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user));
const setStatus = (groupId, itemId, user, body) =>
	request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`).set("Authorization", tokenFor(user)).send(body);


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us22" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});


describe("US 22 AC-03 — the admin replaces a not-found item", () => {

	test("the creator replaces it: the new item is added and the old one becomes replaced", async () => {
		const { creator, group, notFound } = await setup();

		const res = await replace(group._id, notFound._id, creator);

		expect(res.status).toBe(201);
		expect(res.body.item).toMatchObject({ catalogItemId: LOW_FAT_MILK, quantity: 3, unit: "piece", status: "pending", replacementFor: String(notFound._id), addedBy: String(creator._id) });
		expect(res.body.item.catalogItem).toBeTruthy();
		expect(res.body.replaced).toMatchObject({ id: String(notFound._id), status: "replaced", replacedBy: res.body.item.id });
	});

	test("an admin can replace too", async () => {
		const { admin, group, notFound } = await setup();

		const res = await replace(group._id, notFound._id, admin);

		expect(res.status).toBe(201);
	});

	test("the quantity and unit the admin chose are used", async () => {
		const { creator, group, notFound } = await setup();

		const res = await replace(group._id, notFound._id, creator, { catalogItemId: LOW_FAT_MILK, quantity: 1.5, unit: "kg" });

		expect(res.body.item).toMatchObject({ quantity: 1.5, unit: "kg" });
	});

	test("everyone sees the new item, and the replaced one at the end of the list", async () => {
		const { creator, member, group, notFound } = await setup();
		await ListItem.create({ group: group._id, customName: "Bread", quantity: 1, unit: "piece", addedBy: creator._id, createdAt: new Date(Date.now() - 60000) });

		const { body } = await replace(group._id, notFound._id, creator);
		const res = await listItems(group._id, member);

		const ids = res.body.items.map((i) => i.id);
		expect(ids).toHaveLength(3);
		expect(ids[0]).toBe(body.item.id);
		expect(ids[ids.length - 1]).toBe(String(notFound._id));
		expect(res.body.items[ids.length - 1].status).toBe("replaced");
	});

	test("the old item keeps its name, quantity and the member's suggestion", async () => {
		const { creator, group, notFound } = await setup();

		await replace(group._id, notFound._id, creator);

		const old = await ListItem.findById(notFound._id);
		expect(old).toMatchObject({ catalogItemId: FULL_FAT_MILK, quantity: 2, replacementText: "Low fat milk", status: "replaced" });
	});

	test("an item can only be replaced once", async () => {
		const { creator, group, notFound } = await setup();

		await replace(group._id, notFound._id, creator);
		const res = await replace(group._id, notFound._id, creator);

		expect(res.status).toBe(409);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

	test("two admins replacing at the same time: one wins, one gets 409, one new item", async () => {
		const { creator, admin, group, notFound } = await setup();

		const results = await Promise.all([replace(group._id, notFound._id, creator), replace(group._id, notFound._id, admin)]);

		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

	test("members can no longer change the status of a replaced item (409)", async () => {
		const { creator, member, group, notFound } = await setup();
		await replace(group._id, notFound._id, creator);

		const res = await setStatus(group._id, notFound._id, member, { status: "found" });

		expect(res.status).toBe(409);
	});

	test("the new item can be marked by members like any other", async () => {
		const { creator, member, group, notFound } = await setup();
		const { body } = await replace(group._id, notFound._id, creator);

		const res = await setStatus(group._id, body.item.id, member, { status: "found" });

		expect(res.status).toBe(200);
	});

});


describe("US 22 — only not-found items can be replaced", () => {

	test.each(["pending", "found"])("a %s item gets 409 and nothing is added", async (status) => {
		const { creator, group } = await setup();
		const item = await ListItem.create({ group: group._id, customName: "Eggs", quantity: 1, unit: "box", addedBy: creator._id, status });

		const res = await replace(group._id, item._id, creator);

		expect(res.status).toBe(409);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

});


describe("US 22 — who may replace and bad requests", () => {

	test("a regular member gets 403 and nothing changes", async () => {
		const { member, group, notFound } = await setup();

		const res = await replace(group._id, notFound._id, member);

		expect(res.status).toBe(403);
		expect((await ListItem.findById(notFound._id)).status).toBe("notFound");
		expect(await ListItem.countDocuments()).toBe(1);
	});

	test("someone outside the group gets 403", async () => {
		const { outsider, group, notFound } = await setup();

		expect((await replace(group._id, notFound._id, outsider)).status).toBe(403);
	});

	test("no token gets 401", async () => {
		const { group, notFound } = await setup();

		expect((await replace(group._id, notFound._id, null)).status).toBe(401);
	});

	test.each([
		["a catalog id that does not exist", { catalogItemId: "tamimi-0", quantity: 1, unit: "piece" }],
		["no catalog id", { quantity: 1, unit: "piece" }],
		["a negative quantity", { catalogItemId: LOW_FAT_MILK, quantity: -1, unit: "piece" }],
		["a decimal number of pieces", { catalogItemId: LOW_FAT_MILK, quantity: 1.5, unit: "piece" }],
		["an unknown unit", { catalogItemId: LOW_FAT_MILK, quantity: 1, unit: "bag" }],
	])("%s gets 400 and the old item stays not found", async (_label, body) => {
		const { creator, group, notFound } = await setup();

		const res = await replace(group._id, notFound._id, creator, body);

		expect(res.status).toBe(400);
		expect((await ListItem.findById(notFound._id)).status).toBe("notFound");
		expect(await ListItem.countDocuments()).toBe(1);
	});

	test("an item of another group gets 404 through this group", async () => {
		const { creator, group } = await setup();
		const other = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });
		const otherItem = await ListItem.create({ group: other._id, customName: "Bread", quantity: 1, unit: "piece", addedBy: creator._id, status: "notFound" });

		const res = await replace(group._id, otherItem._id, creator);

		expect(res.status).toBe(404);
		expect((await ListItem.findById(otherItem._id)).status).toBe("notFound");
	});

	test("unknown group 404, unknown item 404, invalid ids 400", async () => {
		const { creator, group, notFound } = await setup();

		expect((await replace(new mongoose.Types.ObjectId(), notFound._id, creator)).status).toBe(404);
		expect((await replace(group._id, new mongoose.Types.ObjectId(), creator)).status).toBe(404);
		expect((await replace("bad", notFound._id, creator)).status).toBe(400);
		expect((await replace(group._id, "bad", creator)).status).toBe(400);
	});

});
