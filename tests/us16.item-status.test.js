// US 16: In-Store Item Status Tracking — API tests (Jest + Supertest)
// PATCH /api/groups/:groupId/items/:itemId/status  { status, replacementText? }
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
	const item = await ListItem.create({ group: group._id, customName: "Fresh milk", quantity: 2, unit: "piece", addedBy: creator._id });
	return { creator, admin, member, outsider, group, item };
}

const setStatus = (groupId, itemId, user, body) => {
	const req = request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send(body);
};

const listItems = (groupId, user) => request(app).get(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user));


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us16" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
});


describe("US 16 AC-01 — mark an item as found", () => {

	test("a regular member marks the item found and gets the updated item", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "found" });

		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ id: String(item._id), status: "found", replacementText: null, statusUpdatedBy: String(member._id) });
		expect(res.body.item.statusUpdatedAt).toBeTruthy();
	});

	test("the new status is shared: every other member reads it from the list", async () => {
		const { creator, admin, member, group, item } = await setup();

		await setStatus(group._id, item._id, member, { status: "found" });

		for (const user of [creator, admin]) {
			const res = await listItems(group._id, user);
			expect(res.body.items[0]).toMatchObject({ id: String(item._id), status: "found" });
		}
	});

	test("admins and the creator can mark items too", async () => {
		const { creator, admin, group, item } = await setup();

		expect((await setStatus(group._id, item._id, admin, { status: "found" })).status).toBe(200);
		expect((await setStatus(group._id, item._id, creator, { status: "notFound" })).status).toBe(200);
	});

	test("an item saved before US 16 reads as pending", async () => {
		const { member, group } = await setup();
		const old = await ListItem.collection.insertOne({ group: group._id, customName: "Old row", quantity: 1, unit: "piece", addedBy: member._id, createdAt: new Date(Date.now() + 1000) });

		const res = await listItems(group._id, member);

		expect(res.body.items.find((i) => i.id === String(old.insertedId))).toMatchObject({ status: "pending", replacementText: null });
	});

});


describe("US 16 AC-02 / AC-03 — mark an item as not found, with an optional replacement", () => {

	test("not found without replacement text", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "notFound" });

		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ status: "notFound", replacementText: null });
	});

	test("not found with replacement text saves the text on the item", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "  Almarai low fat milk  " });

		expect(res.status).toBe(200);
		expect(res.body.item.replacementText).toBe("Almarai low fat milk");
		expect((await ListItem.findById(item._id)).replacementText).toBe("Almarai low fat milk");
	});

	test("empty replacement text is stored as no text", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "   " });

		expect(res.body.item.replacementText).toBeNull();
	});

	test("the replacement text is cleared when the item is later marked found", async () => {
		const { member, group, item } = await setup();
		await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "Any milk" });

		const res = await setStatus(group._id, item._id, member, { status: "found" });

		expect(res.body.item).toMatchObject({ status: "found", replacementText: null });
	});

	test("pending undoes a mark", async () => {
		const { member, group, item } = await setup();
		await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "Any milk" });

		const res = await setStatus(group._id, item._id, member, { status: "pending" });

		expect(res.body.item).toMatchObject({ status: "pending", replacementText: null });
	});

	test("101 characters of replacement text is refused; 100 is accepted", async () => {
		const { member, group, item } = await setup();

		expect((await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "a".repeat(101) })).status).toBe(400);
		expect((await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "a".repeat(100) })).status).toBe(200);
	});

	test("replacement text with status found is refused and nothing changes", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "found", replacementText: "Any milk" });

		expect(res.status).toBe(400);
		expect((await ListItem.findById(item._id)).status).toBe("pending");
	});

});


describe("US 16 — who may mark and bad requests", () => {

	test("someone outside the group gets 403 and the status is unchanged", async () => {
		const { outsider, group, item } = await setup();

		const res = await setStatus(group._id, item._id, outsider, { status: "found" });

		expect(res.status).toBe(403);
		expect((await ListItem.findById(item._id)).status).toBe("pending");
	});

	test("a request without a token gets 401", async () => {
		const { group, item } = await setup();

		const res = await setStatus(group._id, item._id, null, { status: "found" });

		expect(res.status).toBe(401);
	});

	test.each([["missing", undefined], ["unknown", "lost"], ["a number", 1], ["replaced (US 22 only)", "replaced"]])(
		"a %s status gets 400", async (_label, status) => {
			const { member, group, item } = await setup();

			const res = await setStatus(group._id, item._id, member, { status });

			expect(res.status).toBe(400);
		});

	test("replacement text that is not text gets 400", async () => {
		const { member, group, item } = await setup();

		const res = await setStatus(group._id, item._id, member, { status: "notFound", replacementText: 5 });

		expect(res.status).toBe(400);
	});

	test("an item of another group gets 404 through this group", async () => {
		const { creator, member, group } = await setup();
		const other = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });
		const otherItem = await ListItem.create({ group: other._id, customName: "Bread", quantity: 1, unit: "piece", addedBy: creator._id });

		const res = await setStatus(group._id, otherItem._id, member, { status: "found" });

		expect(res.status).toBe(404);
		expect((await ListItem.findById(otherItem._id)).status).toBe("pending");
	});

	test("unknown group 404, unknown item 404, invalid ids 400", async () => {
		const { member, group, item } = await setup();

		expect((await setStatus(new mongoose.Types.ObjectId(), item._id, member, { status: "found" })).status).toBe(404);
		expect((await setStatus(group._id, new mongoose.Types.ObjectId(), member, { status: "found" })).status).toBe(404);
		expect((await setStatus("bad", item._id, member, { status: "found" })).status).toBe(400);
		expect((await setStatus(group._id, "bad", member, { status: "found" })).status).toBe(400);
	});

	test("marking does not change the item's name, quantity or unit", async () => {
		const { member, group, item } = await setup();

		await setStatus(group._id, item._id, member, { status: "notFound", replacementText: "Any milk" });

		const after = await ListItem.findById(item._id);
		expect(after).toMatchObject({ customName: "Fresh milk", quantity: 2, unit: "piece" });
	});

});
