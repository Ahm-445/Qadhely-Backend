// Item history and "Complete list" — API tests (Jest + Supertest)
//
// ItemHistory is the append-only record the AI suggestions read: every item added to a group's
// list and, once the list is completed, the trip it was bought in. Removing an item from the list
// never touches it; only deleting the group removes its rows.
//
// POST /api/groups/:groupId/complete-list stores the visible list under one tripId and clears it.
//
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

jest.mock("../src/services/authentica");

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const accountRoutes = require("../src/routes/accountRoutes");
const { sendAuthOtp, verifyOtp } = require("../src/services/authentica");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");
const ItemHistory = require("../src/models/ItemHistory");
const AccountDeletionOtp = require("../src/models/AccountDeletionOtp");
const OtpRequestLog = require("../src/models/OtpRequestLog");


// small app with only the group and account routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);
app.use("/api/account", accountRoutes);


// catalog ids shaped like the real ones; the add endpoint checks the shape only
const MILK = "tamimi-1196";
const FULL_FAT_MILK = "tamimi-154850";
const BREAD = "tamimi-137805";

let mongo;

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

// G1: Sara (creator), Omar (admin), Ali (member); Noura is outside
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


const addItem = (groupId, user, body) => {
	const req = request(app).post(`/api/groups/${groupId}/items`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send(body);
};

const complete = (groupId, user) => {
	const req = request(app).post(`/api/groups/${groupId}/complete-list`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send();
};

const listItems = (groupId, user) => request(app).get(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user));

const setStatus = (groupId, itemId, user, body) =>
	request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`).set("Authorization", tokenFor(user)).send(body);

const replaceItem = (groupId, itemId, user, body) =>
	request(app).post(`/api/groups/${groupId}/items/${itemId}/replace`).set("Authorization", tokenFor(user)).send(body);

const removeItem = (groupId, itemId, user) =>
	request(app).delete(`/api/groups/${groupId}/items/${itemId}`).set("Authorization", tokenFor(user));

const deleteGroup = (groupId, user) =>
	request(app).delete(`/api/groups/${groupId}`).set("Authorization", tokenFor(user)).send({ confirmed: true });

const tripRows = (groupId) => ItemHistory.find({ group: groupId, tripId: { $ne: null } }).lean();
const addedRows = (groupId) => ItemHistory.find({ group: groupId, tripId: null }).lean();


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_item_history" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([
		User.deleteMany({}),
		Group.deleteMany({}),
		ListItem.deleteMany({}),
		ItemHistory.deleteMany({}),
		AccountDeletionOtp.deleteMany({}),
		OtpRequestLog.deleteMany({}),
	]);
	jest.clearAllMocks();
	sendAuthOtp.mockResolvedValue(true);
	verifyOtp.mockResolvedValue("valid");
});


describe("every item that is created is recorded", () => {

	test("an added item is recorded with its quantity, unit and who added it", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 3, unit: "kg" });

		expect(res.status).toBe(201);

		const rows = await ItemHistory.find({ group: group._id }).lean();

		expect(rows).toHaveLength(1);
		expect(rows[0].catalogItemId).toBe(MILK);
		expect(rows[0].quantity).toBe(3);
		expect(rows[0].unit).toBe("kg");
		expect(String(rows[0].addedBy)).toBe(String(creator._id));
		expect(rows[0].addedAt.getTime()).toBe(new Date(res.body.item.createdAt).getTime());
	});

	test("a new addition has no trip until the list is completed", async () => {
		const { creator, group } = await setup();

		await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });

		const rows = await ItemHistory.find({ group: group._id }).lean();

		expect(rows[0].tripId).toBeNull();
		expect(rows[0].status).toBe("pending");
	});

	test("a replacement item is recorded as a new addition", async () => {
		const { creator, admin, group } = await setup();
		const added = await addItem(group._id, creator, { catalogItemId: FULL_FAT_MILK, quantity: 2, unit: "piece" });
		await setStatus(group._id, added.body.item.id, admin, { status: "notFound" });

		const res = await replaceItem(group._id, added.body.item.id, admin, { catalogItemId: MILK, quantity: 3, unit: "piece" });

		expect(res.status).toBe(201);

		const rows = await ItemHistory.find({ group: group._id }).lean();

		expect(rows).toHaveLength(2);
		expect(rows.some((r) => r.catalogItemId === MILK && r.quantity === 3)).toBe(true);
	});

	test("removing an item from the list keeps its history", async () => {
		const { creator, group } = await setup();
		const added = await addItem(group._id, creator, { catalogItemId: BREAD, quantity: 1, unit: "piece" });

		expect((await removeItem(group._id, added.body.item.id, creator)).status).toBe(200);

		const rows = await ItemHistory.find({ group: group._id }).lean();

		expect(rows).toHaveLength(1);
		expect(rows[0].catalogItemId).toBe(BREAD);
	});

	test("an item that failed to be added is not recorded", async () => {
		const { creator, group } = await setup();

		const res = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1.5, unit: "piece" });

		expect(res.status).toBe(400);
		expect(await ItemHistory.countDocuments({ group: group._id })).toBe(0);
	});

});


describe("POST /api/groups/:groupId/complete-list", () => {

	test("a regular member cannot complete the list", async () => {
		const { creator, member, group } = await setup();
		const added = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		await setStatus(group._id, added.body.item.id, creator, { status: "found" });

		const res = await complete(group._id, member);

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
		expect(await tripRows(group._id)).toHaveLength(0);
	});

	test("an outsider cannot complete the list", async () => {
		const { creator, outsider, group } = await setup();
		await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });

		expect((await complete(group._id, outsider)).status).toBe(403);
	});

	test("the list cannot be completed while an item is still pending", async () => {
		const { creator, group } = await setup();
		const added = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		await addItem(group._id, creator, { catalogItemId: BREAD, quantity: 2, unit: "piece" });
		await setStatus(group._id, added.body.item.id, creator, { status: "found" });

		const res = await complete(group._id, creator);

		expect(res.status).toBe(409);
		expect(res.body.code).toBe("LIST_NOT_RESOLVED");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
		expect(await tripRows(group._id)).toHaveLength(0);
	});

	test("an empty list cannot be completed", async () => {
		const { creator, group } = await setup();

		const res = await complete(group._id, creator);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("LIST_EMPTY");
	});

	test("completing the list stores what was on it under one trip and clears it", async () => {
		const { creator, admin, group } = await setup();
		const milk = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		const bread = await addItem(group._id, creator, { catalogItemId: BREAD, quantity: 2, unit: "piece" });
		await request(app)
			.patch(`/api/groups/${group._id}/items/${milk.body.item.id}`)
			.set("Authorization", tokenFor(creator))
			.send({ quantity: 3, unit: "piece" });
		await setStatus(group._id, milk.body.item.id, admin, { status: "found" });
		await setStatus(group._id, bread.body.item.id, admin, { status: "notFound" });

		const res = await complete(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.itemCount).toBe(2);
		expect(mongoose.isValidObjectId(res.body.tripId)).toBe(true);

		const rows = await ItemHistory.find({ group: group._id, tripId: res.body.tripId }).lean();

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => [r.catalogItemId, r.quantity, r.status]).sort()).toEqual([
			[BREAD, 2, "notFound"],
			[MILK, 3, "found"],
		].sort());
		expect(String(rows[0].tripId)).toBe(String(res.body.tripId));

		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("the additions that led to the trip stay in the history without a trip", async () => {
		const { creator, group } = await setup();
		const milk = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		await setStatus(group._id, milk.body.item.id, creator, { status: "found" });

		await complete(group._id, creator);

		const rows = await addedRows(group._id);

		expect(rows).toHaveLength(1);
		expect(rows[0].catalogItemId).toBe(MILK);
	});

	test("a replaced item counts as resolved", async () => {
		const { creator, admin, group } = await setup();
		const milk = await addItem(group._id, creator, { catalogItemId: FULL_FAT_MILK, quantity: 2, unit: "piece" });
		const bread = await addItem(group._id, creator, { catalogItemId: BREAD, quantity: 1, unit: "piece" });
		await setStatus(group._id, milk.body.item.id, admin, { status: "notFound" });
		const replacement = await replaceItem(group._id, milk.body.item.id, admin, { catalogItemId: MILK, quantity: 2, unit: "piece" });
		// the replacement is a new item, so a member still has to mark it before the list can be closed
		await setStatus(group._id, replacement.body.item.id, admin, { status: "found" });
		await setStatus(group._id, bread.body.item.id, admin, { status: "found" });

		const res = await complete(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.itemCount).toBe(3);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(0);
	});

	test("each completion is a trip of its own", async () => {
		const { creator, group } = await setup();
		const first = await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		await setStatus(group._id, first.body.item.id, creator, { status: "found" });
		const trip1 = await complete(group._id, creator);

		const second = await addItem(group._id, creator, { catalogItemId: BREAD, quantity: 2, unit: "piece" });
		await setStatus(group._id, second.body.item.id, creator, { status: "found" });
		const trip2 = await complete(group._id, creator);

		expect(trip1.status).toBe(200);
		expect(trip2.status).toBe(200);
		expect(String(trip1.body.tripId)).not.toBe(String(trip2.body.tripId));
		expect(await ItemHistory.countDocuments({ group: group._id, tripId: { $ne: null } })).toBe(2);
	});

	test("an invalid group id gets 400", async () => {
		const { creator } = await setup();

		expect((await complete("not-an-id", creator)).status).toBe(400);
	});

});


describe("deleting a group", () => {

	test("deletes the group's history and keeps another group's", async () => {
		const { creator, group } = await setup();
		const other = await Group.create({
			name: "Office snacks",
			createdBy: creator._id,
			members: [{ user: creator._id, role: "creator" }],
		});
		await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		await addItem(other._id, creator, { catalogItemId: BREAD, quantity: 1, unit: "piece" });

		expect((await deleteGroup(group._id, creator)).status).toBe(200);

		expect(await ItemHistory.countDocuments({ group: group._id })).toBe(0);
		expect(await ItemHistory.countDocuments({ group: other._id })).toBe(1);
	});

});


describe("deleting the account of a group's last member", () => {

	test("deletes the group's history with it", async () => {
		// the creator is the only member, so deleting the account deletes the group
		const creator = await User.create({ handleName: "Sara", phoneNumber: "+966550000001" });
		const group = await Group.create({
			name: "Solo list",
			createdBy: creator._id,
			members: [{ user: creator._id, role: "creator" }],
		});
		await addItem(group._id, creator, { catalogItemId: MILK, quantity: 1, unit: "piece" });
		expect(await ItemHistory.countDocuments({ group: group._id })).toBe(1);

		const sent = await request(app).post("/api/account/delete/send-otp").set("Authorization", tokenFor(creator)).send();
		const res = await request(app)
			.post("/api/account/delete/verify")
			.set("Authorization", tokenFor(creator))
			.send({ otp: "123456", confirmed: true });

		expect(sent.status).toBe(200);
		expect(res.status).toBe(200);
		expect(await Group.countDocuments({ _id: group._id })).toBe(0);
		expect(await ItemHistory.countDocuments({ group: group._id })).toBe(0);
	});

});
