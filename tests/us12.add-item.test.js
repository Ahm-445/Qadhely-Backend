// US 12: Add Item — API tests (Jest + Supertest)
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

const addItem = (groupId, user, body) => {
	const req = request(app).post(`/api/groups/${groupId}/items`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send(body);
};


const validItem = { catalogItemId: CATALOG_ITEM_ID, quantity: 2, unit: "piece" };


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us12" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});


describe("POST /api/groups/:groupId/items — AC-01 (an admin stores an item on the group's list)", () => {

	test("the creator stores a catalog item and the row is in the database", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, validItem);

		expect(res.status).toBe(201);
		expect(res.body.item).toMatchObject({
			groupId: String(group._id),
			catalogItemId: CATALOG_ITEM_ID,
			quantity: 2,
			unit: "piece",
			addedBy: String(creator._id),
		});
		expect(res.body.item.catalogItem).toMatchObject({ id: CATALOG_ITEM_ID, name_en: "Large White Eggs Plastic Packaging" });

		const stored = await ListItem.findById(res.body.item.id).lean();
		expect(stored).toMatchObject({
			group: group._id,
			catalogItemId: CATALOG_ITEM_ID,
			quantity: 2,
			unit: "piece",
			addedBy: creator._id,
		});
	});

	test("an admin stores an item too", async () => {
		const { admin, group } = await setup();

		const res = await addItem(group._id, admin, validItem);

		expect(res.status).toBe(201);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

	test("a quantity of 0 is stored", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: 0 });

		expect(res.status).toBe(201);
		expect(res.body.item.quantity).toBe(0);
	});

	test("a decimal quantity is stored when the unit is kg", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: 1.5, unit: "kg" });

		expect(res.status).toBe(201);
		expect(res.body.item).toMatchObject({ quantity: 1.5, unit: "kg" });
	});

	test("box is accepted as a unit", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: 3, unit: "box" });

		expect(res.status).toBe(201);
		expect(res.body.item.unit).toBe("box");
	});

	test("the same catalog item twice makes two rows", async () => {
		const { creator, group } = await setup();

		await addItem(group._id, creator, validItem);
		const res = await addItem(group._id, creator, { ...validItem, quantity: 6 });

		expect(res.status).toBe(201);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

	test("the response does not include a custom name for a catalog item", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, validItem);

		expect(res.body.item.customName).toBeUndefined();
	});

});


describe("POST /api/groups/:groupId/items — AC-02 (only the Group Creator and admins can add)", () => {

	test("a regular member gets 403 and nothing is stored", async () => {
		const { member, group } = await setup();

		const res = await addItem(group._id, member, validItem);

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("someone outside the group gets 403 and nothing is stored", async () => {
		const { outsider, group } = await setup();

		const res = await addItem(group._id, outsider, validItem);

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("a request without a token gets 401", async () => {
		const { group } = await setup();

		const res = await addItem(group._id, null, validItem);

		expect(res.status).toBe(401);
	});

});


describe("POST /api/groups/:groupId/items — AC-03 (the quantity and the unit are validated)", () => {

	test("a decimal quantity is rejected when the unit is a piece", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: 1.5, unit: "piece" });

		expect(res.status).toBe(400);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("a decimal quantity is rejected when the unit is a box", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: 2.5, unit: "box" });

		expect(res.status).toBe(400);
	});

	test("a negative quantity is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: -1 });

		expect(res.status).toBe(400);
	});

	test("a quantity that is not a number is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, quantity: "2" });

		expect(res.status).toBe(400);
	});

	test("a missing quantity is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { catalogItemId: CATALOG_ITEM_ID, unit: "piece" });

		expect(res.status).toBe(400);
	});

	test("a unit outside kg / piece / box is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, unit: "litre" });

		expect(res.status).toBe(400);
	});

	test("a missing catalog item id is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { quantity: 2, unit: "piece" });

		expect(res.status).toBe(400);
	});

	test("a catalog item id with a bad shape is rejected", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { ...validItem, catalogItemId: "tamimi 137805/../" });

		expect(res.status).toBe(400);
	});

});


describe("POST /api/groups/:groupId/items — AC-04 (the group is validated)", () => {

	test("an unknown group gets 404", async () => {
		const { creator } = await setup();

		const res = await addItem(new mongoose.Types.ObjectId(), creator, validItem);

		expect(res.status).toBe(404);
	});

	test("a group id that is not an object id gets 400", async () => {
		const { creator } = await setup();

		const res = await addItem("not-an-id", creator, validItem);

		expect(res.status).toBe(400);
	});

});

describe("ListItem — a custom request carries its own name instead of a catalog id", () => {

	test("a custom item is stored without a catalog id", async () => {
		const { creator, group } = await setup();

		const item = await ListItem.create({
			group: group._id,
			customName: "Mom's birthday cake",
			quantity: 1,
			unit: "piece",
			addedBy: creator._id,
		});

		expect(item.catalogItemId).toBeUndefined();
		expect(item.customName).toBe("Mom's birthday cake");
	});

	test("an item with neither a catalog id nor a custom name is rejected", async () => {
		const { creator, group } = await setup();

		await expect(ListItem.create({
			group: group._id,
			quantity: 1,
			unit: "piece",
			addedBy: creator._id,
		})).rejects.toThrow(/catalog item id/i);
	});

});
