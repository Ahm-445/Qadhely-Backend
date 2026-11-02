// US 13: Remove Item from List — API tests (Jest + Supertest)
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

const CATALOG_ITEM_ID = "tamimi-137805";





beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us13" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});


// one row on the group's list, as US 12 stores it
const storeItem = (group, user, extra = {}) => ListItem.create({
	group: group._id,
	catalogItemId: CATALOG_ITEM_ID,
	quantity: 2,
	unit: "piece",
	addedBy: user._id,
	...extra,
});

const removeItem = (groupId, itemId, user) => {
	const req = request(app).delete(`/api/groups/${groupId}/items/${itemId}`);
	if (user) req.set("Authorization", tokenFor(user));
	return req;
};

const listItems = (groupId, user) => {
	const req = request(app).get(`/api/groups/${groupId}/items`);
	if (user) req.set("Authorization", tokenFor(user));
	return req;
};


describe("DELETE /api/groups/:groupId/items/:itemId — AC-01 (an admin removes an item from the list)", () => {

	test("the creator removes an item and it is gone from the database", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await removeItem(group._id, item._id, creator);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ message: "Item removed", itemId: String(item._id) });
		expect(await ListItem.findById(item._id)).toBeNull();
	});

	test("an admin removes an item too", async () => {
		const { creator, admin, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await removeItem(group._id, item._id, admin);

		expect(res.status).toBe(200);
		expect(await ListItem.countDocuments()).toBe(0);
	});

	test("only the chosen item is removed; the rest of the list stays", async () => {
		const { creator, group } = await setup();
		const keep = await storeItem(group, creator, { quantity: 1 });
		const remove = await storeItem(group, creator, { quantity: 5 });

		await removeItem(group._id, remove._id, creator);

		const left = await ListItem.find();
		expect(left).toHaveLength(1);
		expect(String(left[0]._id)).toBe(String(keep._id));
	});

	test("a custom item (no catalog id) can be removed", async () => {
		const { creator, group } = await setup();
		const item = await ListItem.create({ group: group._id, customName: "Fresh mint", quantity: 1, unit: "piece", addedBy: creator._id });

		const res = await removeItem(group._id, item._id, creator);

		expect(res.status).toBe(200);
		expect(await ListItem.countDocuments()).toBe(0);
	});

	test("the removed item no longer shows in the list", async () => {
		const { creator, member, group } = await setup();
		const item = await storeItem(group, creator);

		await removeItem(group._id, item._id, creator);
		const res = await listItems(group._id, member);

		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([]);
	});

});


describe("DELETE /api/groups/:groupId/items/:itemId — who may remove", () => {

	test("a regular member gets 403 and the item stays", async () => {
		const { creator, member, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await removeItem(group._id, item._id, member);

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments()).toBe(1);
	});

	test("someone outside the group gets 403 and the item stays", async () => {
		const { creator, outsider, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await removeItem(group._id, item._id, outsider);

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments()).toBe(1);
	});

	test("a request without a token gets 401", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await removeItem(group._id, item._id, null);

		expect(res.status).toBe(401);
		expect(await ListItem.countDocuments()).toBe(1);
	});

	test("an admin of another group cannot remove this group's item through their own group", async () => {
		const { creator, group } = await setup();
		const otherCreator = await User.create({ handleName: "Huda", phoneNumber: "+966559999999" });
		const otherGroup = await Group.create({ name: "Other", createdBy: otherCreator._id, members: [{ user: otherCreator._id, role: "creator" }] });
		const item = await storeItem(group, creator);

		const res = await removeItem(otherGroup._id, item._id, otherCreator);

		expect(res.status).toBe(404);
		expect(await ListItem.countDocuments()).toBe(1);
	});

});


describe("DELETE /api/groups/:groupId/items/:itemId — bad requests", () => {

	test("an item that does not exist gets 404", async () => {
		const { creator, group } = await setup();

		const res = await removeItem(group._id, new mongoose.Types.ObjectId(), creator);

		expect(res.status).toBe(404);
	});

	test("removing the same item twice gets 404 the second time", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		await removeItem(group._id, item._id, creator);
		const res = await removeItem(group._id, item._id, creator);

		expect(res.status).toBe(404);
	});

	test("an unknown group gets 404", async () => {
		const { creator } = await setup();

		const res = await removeItem(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), creator);

		expect(res.status).toBe(404);
	});

	test("a group id that is not an object id gets 400", async () => {
		const { creator } = await setup();

		const res = await removeItem("not-an-id", new mongoose.Types.ObjectId(), creator);

		expect(res.status).toBe(400);
	});

	test("an item id that is not an object id gets 400", async () => {
		const { creator, group } = await setup();

		const res = await removeItem(group._id, "not-an-id", creator);

		expect(res.status).toBe(400);
	});

});


describe("GET /api/groups/:groupId/items — the list the app shows", () => {

	test("every member of the group reads the items, newest first", async () => {
		const { creator, member, group } = await setup();
		const first = await storeItem(group, creator, { quantity: 1 });
		const second = await storeItem(group, creator, { quantity: 3, createdAt: new Date(Date.now() + 1000) });

		const res = await listItems(group._id, member);

		expect(res.status).toBe(200);
		expect(res.body.groupId).toBe(String(group._id));
		expect(res.body.items.map((i) => i.id)).toEqual([String(second._id), String(first._id)]);
		expect(res.body.items[0]).toMatchObject({ catalogItemId: CATALOG_ITEM_ID, quantity: 3, unit: "piece" });
	});

	test("only this group's items are returned", async () => {
		const { creator, group } = await setup();
		const otherGroup = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });
		await storeItem(group, creator);
		await storeItem(otherGroup, creator);

		const res = await listItems(group._id, creator);

		expect(res.body.items).toHaveLength(1);
	});

	test("someone outside the group gets 403", async () => {
		const { outsider, group } = await setup();

		const res = await listItems(group._id, outsider);

		expect(res.status).toBe(403);
	});

	test("an unknown group gets 404", async () => {
		const { creator } = await setup();

		const res = await listItems(new mongoose.Types.ObjectId(), creator);

		expect(res.status).toBe(404);
	});

});
