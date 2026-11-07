// US 14: Modify Item Quantity and Unit — API tests (Jest + Supertest)
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
	await mongoose.connect(uri, { dbName: "qadhely_test_us14" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});

// the controllers log errors; keep the test output readable
beforeEach(() => {
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
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

const modifyItem = (groupId, itemId, user, body) => {
	const req = request(app).patch(`/api/groups/${groupId}/items/${itemId}`).send(body);
	if (user) req.set("Authorization", tokenFor(user));
	return req;
};


describe("PATCH /api/groups/:groupId/items/:itemId — AC-02 (the change is saved)", () => {

	test("the creator changes the quantity and unit, and the database has them", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, creator, { quantity: 3, unit: "box" });

		expect(res.status).toBe(200);
		expect(res.body.message).toBe("Item updated");
		expect(res.body.item).toMatchObject({ id: String(item._id), quantity: 3, unit: "box", catalogItemId: CATALOG_ITEM_ID });
		expect(res.body.item.catalogItem).toMatchObject({ id: CATALOG_ITEM_ID });

		const stored = await ListItem.findById(item._id).lean();
		expect(stored).toMatchObject({ quantity: 3, unit: "box" });
	});

	test("an admin can modify too", async () => {
		const { creator, admin, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, admin, { quantity: 1.5, unit: "kg" });

		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ quantity: 1.5, unit: "kg" });
	});

	test("only the chosen item changes", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);
		const other = await storeItem(group, creator, { quantity: 5 });

		await modifyItem(group._id, item._id, creator, { quantity: 1, unit: "piece" });

		expect((await ListItem.findById(other._id).lean()).quantity).toBe(5);
	});

});


describe("PATCH /api/groups/:groupId/items/:itemId — AC-04 (an invalid change is refused)", () => {

	test.each([
		["a decimal quantity for a unit other than kg", { quantity: 2.5, unit: "piece" }],
		["a negative quantity", { quantity: -1, unit: "piece" }],
		["a quantity that is not a number", { quantity: "3", unit: "piece" }],
		["a missing quantity", { unit: "piece" }],
		["an unknown unit", { quantity: 1, unit: "litre" }],
		["a missing unit", { quantity: 1 }],
	])("%s gets 400 and the item is unchanged", async (_label, body) => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, creator, body);

		expect(res.status).toBe(400);
		expect(typeof res.body.error).toBe("string");
		expect(await ListItem.findById(item._id).lean()).toMatchObject({ quantity: 2, unit: "piece" });
	});

});


describe("PATCH /api/groups/:groupId/items/:itemId — who can modify (NFR-10)", () => {

	test("a regular member gets 403 and the item is unchanged", async () => {
		const { creator, member, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, member, { quantity: 9, unit: "piece" });

		expect(res.status).toBe(403);
		expect((await ListItem.findById(item._id).lean()).quantity).toBe(2);
	});

	test("someone outside the group gets 403", async () => {
		const { creator, outsider, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, outsider, { quantity: 9, unit: "piece" });

		expect(res.status).toBe(403);
	});

	test("without a token the request is rejected", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		const res = await modifyItem(group._id, item._id, null, { quantity: 9, unit: "piece" });

		expect(res.status).toBe(401);
	});

});


describe("PATCH /api/groups/:groupId/items/:itemId — ids", () => {

	test("an item of another group is not found and stays unchanged", async () => {
		const { creator, group } = await setup();
		const otherGroup = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });
		const item = await storeItem(otherGroup, creator);

		const res = await modifyItem(group._id, item._id, creator, { quantity: 9, unit: "piece" });

		expect(res.status).toBe(404);
		expect((await ListItem.findById(item._id).lean()).quantity).toBe(2);
	});

	test("an unknown item gets 404", async () => {
		const { creator, group } = await setup();

		const res = await modifyItem(group._id, new mongoose.Types.ObjectId(), creator, { quantity: 1, unit: "piece" });

		expect(res.status).toBe(404);
	});

	test("malformed ids get 400", async () => {
		const { creator, group } = await setup();
		const item = await storeItem(group, creator);

		expect((await modifyItem("not-an-id", item._id, creator, { quantity: 1, unit: "piece" })).status).toBe(400);
		expect((await modifyItem(group._id, "not-an-id", creator, { quantity: 1, unit: "piece" })).status).toBe(400);
	});

});
