// US 21 + "Complete list" (item history): how the two behave together (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Expo's push service is replaced by a mock: nothing real is sent.
//
// US 21 notifies the creator and admins when the last outstanding item is marked Found and every
// item is Found or Replaced. The admin's "Complete list" action archives the list into the item
// history and clears it; it is not a trigger for the notification, and it starts a new trip.

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
const ItemHistory = require("../src/models/ItemHistory");
const { whenNotificationsIdle, NOTIFICATION_TYPES } = require("../src/services/pushNotifications");


const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);

const realFetch = global.fetch;

let mongo;
let fetchMock;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

const tok = (n) => `ExponentPushToken[${String(n).padStart(22, "0")}]`;

let phoneCounter = 0;

const makeUser = (handleName, pushTokens = []) => {
	phoneCounter += 1;
	return User.create({ handleName, phoneNumber: `+96655${String(phoneCounter).padStart(7, "0")}`, pushTokens });
};

// creator Sara (1 phone), admin Omar (1 phone), member Ali (1 phone)
async function setup() {
	const creator = await makeUser("Sara", [tok(1)]);
	const admin = await makeUser("Omar", [tok(2)]);
	const member = await makeUser("Ali", [tok(5)]);

	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
			{ user: member._id, role: "member" },
		],
	});

	return { creator, admin, member, group };
}

const CATALOG_A = "tamimi-1196";
const CATALOG_B = "tamimi-154850";

const makeItem = (group, user, fields = {}) => ListItem.create({
	group: group._id, catalogItemId: CATALOG_A, quantity: 1, unit: "piece", addedBy: user._id, ...fields,
});

const setStatus = (group, item, user, body) =>
	request(app).patch(`/api/groups/${group._id}/items/${item._id}/status`).set("Authorization", tokenFor(user)).send(body);

const completeList = (group, user) =>
	request(app).post(`/api/groups/${group._id}/complete-list`).set("Authorization", tokenFor(user));

const addItem = (group, user) =>
	request(app).post(`/api/groups/${group._id}/items`).set("Authorization", tokenFor(user)).send({ catalogItemId: CATALOG_B, quantity: 2, unit: "piece" });

const replaceItem = (group, item, user) =>
	request(app).post(`/api/groups/${group._id}/items/${item._id}/replace`).set("Authorization", tokenFor(user)).send({ catalogItemId: CATALOG_B, quantity: 1, unit: "piece" });

const mark = async (group, item, user, body) => {
	const res = await setStatus(group, item, user, body);
	await whenNotificationsIdle();
	return res;
};

const acceptAll = async (url, options) => {
	const messages = JSON.parse(options.body);
	return { ok: true, status: 200, json: async () => ({ data: messages.map(() => ({ status: "ok", id: "ticket" })) }) };
};

const allMessages = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));
const completedMessages = () => allMessages().filter((m) => m.data.type === NOTIFICATION_TYPES.LIST_COMPLETED);

const ADMIN_TOKENS = [tok(1), tok(2)];

const marker = async (group) => (await Group.findById(group._id).lean()).listCompletedNotifiedAt;
const itemCount = (group) => ListItem.countDocuments({ group: group._id });
const tripRows = (group) => ItemHistory.find({ group: group._id, tripId: { $ne: null } }).lean();


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us21_complete" });
	await Promise.all([User.init(), Group.init(), ListItem.init(), ItemHistory.init()]);
});

afterAll(async () => {
	global.fetch = realFetch;
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({}), ItemHistory.deleteMany({})]);
	fetchMock = jest.fn(acceptAll);
	global.fetch = fetchMock;
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());


describe("one shopping trip, start to finish", () => {

	test("last item Found notifies the creator and admins once; Complete list archives and clears without notifying again", async () => {
		const { creator, admin, group } = await setup();
		const first = await makeItem(group, creator);
		const second = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, first, admin, { status: "found" });
		expect(completedMessages()).toHaveLength(0);

		await mark(group, second, admin, { status: "found" });
		expect(completedMessages().map((m) => m.to).sort()).toEqual(ADMIN_TOKENS);
		expect(await marker(group)).not.toBeNull();

		const res = await completeList(group, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(200);
		expect(res.body.itemCount).toBe(2);
		expect(await itemCount(group)).toBe(0);
		expect(await tripRows(group)).toHaveLength(2);
		expect(completedMessages()).toHaveLength(2); // still only the two from the Found
	});

	test("Complete list clears the completion marker", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });
		expect(await marker(group)).not.toBeNull();

		await completeList(group, creator);

		expect(await marker(group)).toBeNull();
	});

	test("the next trip notifies again, and exactly once", async () => {
		const { creator, admin, group } = await setup();
		const first = await makeItem(group, creator);

		await mark(group, first, admin, { status: "found" });
		await completeList(group, creator);

		const added = await addItem(group, creator);
		expect(added.status).toBe(201);

		await mark(group, { _id: added.body.item.id }, admin, { status: "found" });
		await mark(group, { _id: added.body.item.id }, admin, { status: "found" }); // pressing Found twice

		expect(completedMessages()).toHaveLength(4); // two admins x two trips
	});

	test("regular members never get the notification, before or after Complete list", async () => {
		const { creator, admin, group } = await setup();
		const first = await makeItem(group, creator);

		await mark(group, first, admin, { status: "found" });
		await completeList(group, creator);

		expect(completedMessages().map((m) => m.to)).not.toContain(tok(5));
	});

	test("the history keeps the trip's items with their final status", async () => {
		const { creator, admin, group } = await setup();
		const found = await makeItem(group, creator);
		const missing = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, found, admin, { status: "found" });
		await mark(group, missing, admin, { status: "notFound" });
		await completeList(group, creator);

		const rows = await tripRows(group);

		expect(rows.map((row) => row.status).sort()).toEqual(["found", "notFound"]);
		expect(new Set(rows.map((row) => String(row.tripId))).size).toBe(1);
	});
});


describe("NotFound items", () => {

	test("a NotFound item blocks the US 21 notification", async () => {
		const { creator, admin, group } = await setup();
		const found = await makeItem(group, creator);
		const missing = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, found, admin, { status: "found" });
		await mark(group, missing, admin, { status: "notFound" });

		expect(completedMessages()).toHaveLength(0);
		expect(await marker(group)).toBeNull();
	});

	test("Complete list may archive a list that has NotFound items, and sends no US 21 notification", async () => {
		const { creator, admin, group } = await setup();
		const found = await makeItem(group, creator);
		const missing = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, found, admin, { status: "found" });
		await mark(group, missing, admin, { status: "notFound" });

		const res = await completeList(group, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(200);
		expect(await itemCount(group)).toBe(0);
		expect(await tripRows(group)).toHaveLength(2);
		expect(completedMessages()).toHaveLength(0);
		expect(await marker(group)).toBeNull();
	});

	test("a list that was NotFound and archived does not stop the next trip from notifying", async () => {
		const { creator, admin, group } = await setup();
		const missing = await makeItem(group, creator, { status: "notFound" });

		await completeList(group, creator);

		const added = await addItem(group, creator);
		await mark(group, { _id: added.body.item.id }, admin, { status: "found" });

		expect(missing).toBeTruthy();
		expect(completedMessages()).toHaveLength(2);
	});

	test("a NotFound item later marked Found completes the list and notifies once", async () => {
		const { creator, admin, group } = await setup();
		const found = await makeItem(group, creator);
		const missing = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, found, admin, { status: "found" });
		await mark(group, missing, admin, { status: "notFound" });
		await mark(group, missing, admin, { status: "found" });

		expect(completedMessages()).toHaveLength(2);
	});

	test("a replaced item whose replacement is found completes the list; Complete list then archives both", async () => {
		const { creator, admin, group } = await setup();
		const old = await makeItem(group, creator, { status: "notFound" });

		const replaced = await replaceItem(group, old, admin);
		expect(replaced.status).toBe(201);

		await mark(group, { _id: replaced.body.item.id }, admin, { status: "found" });
		expect(completedMessages()).toHaveLength(2);

		const res = await completeList(group, creator);

		expect(res.status).toBe(200);
		expect(res.body.itemCount).toBe(2);
		expect(await marker(group)).toBeNull();
		expect(await tripRows(group)).toHaveLength(2);
	});
});


describe("Complete list keeps its own rules", () => {

	test("a pending item blocks it (409): nothing archived, the marker is untouched", async () => {
		const { creator, admin, group } = await setup();
		const done = await makeItem(group, creator);

		await mark(group, done, admin, { status: "found" });
		await makeItem(group, creator, { catalogItemId: CATALOG_B }); // new pending item: reopens the list
		await Group.updateOne({ _id: group._id }, { $set: { listCompletedNotifiedAt: new Date() } });

		const res = await completeList(group, creator);

		expect(res.status).toBe(409);
		expect(await itemCount(group)).toBe(2);
		expect(await tripRows(group)).toHaveLength(0);
	});

	test("an empty list is refused (400), and an empty list never triggers US 21", async () => {
		const { creator, group } = await setup();

		expect((await completeList(group, creator)).status).toBe(400);
		await whenNotificationsIdle();
		expect(completedMessages()).toHaveLength(0);
	});

	test("a regular member cannot complete the list (403) and nothing changes", async () => {
		const { creator, admin, member, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });

		const res = await completeList(group, member);

		expect(res.status).toBe(403);
		expect(await itemCount(group)).toBe(1);
		expect(await marker(group)).not.toBeNull();
	});

	test("a failed archive keeps the list and the marker as they were", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });

		jest.spyOn(ItemHistory, "insertMany").mockRejectedValueOnce(new Error("db down"));

		const res = await completeList(group, creator);

		expect(res.status).toBe(500);
		expect(await itemCount(group)).toBe(1);
		expect(await marker(group)).not.toBeNull();
		expect(completedMessages()).toHaveLength(2);
	});

	test("a failing marker reset never fails the completion", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });

		jest.spyOn(Group, "updateOne").mockRejectedValueOnce(new Error("db down"));

		const res = await completeList(group, creator);

		expect(res.status).toBe(200);
		expect(await itemCount(group)).toBe(0);
	});
});


describe("every way an item can be created clears a stale marker", () => {

	const stale = (group) => Group.updateOne({ _id: group._id }, { $set: { listCompletedNotifiedAt: new Date() } });

	test("adding through the app", async () => {
		const { creator, group } = await setup();

		await stale(group);
		await addItem(group, creator);

		expect(await marker(group)).toBeNull();
	});

	test("replacing an item", async () => {
		const { creator, admin, group } = await setup();
		const old = await makeItem(group, creator, { status: "notFound" });

		await stale(group);
		await replaceItem(group, old, admin);

		expect(await marker(group)).toBeNull();
	});

	test("an item created some other way (like the Telegram bot: ListItem.create)", async () => {
		const { creator, group } = await setup();

		await stale(group);
		await makeItem(group, creator);

		expect(await marker(group)).toBeNull();
	});

	test("so the next completion after a bot-added item still notifies", async () => {
		const { creator, admin, group } = await setup();
		const first = await makeItem(group, creator);

		await mark(group, first, admin, { status: "found" });
		await completeList(group, creator);

		const viaBot = await makeItem(group, creator, { catalogItemId: CATALOG_B });

		await mark(group, viaBot, admin, { status: "found" });

		expect(completedMessages()).toHaveLength(4);
	});

	test("the safety net does not touch another group's marker", async () => {
		const { creator, group } = await setup();
		const other = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });

		await stale(group);
		await stale(other);
		await makeItem(group, creator);

		expect(await marker(group)).toBeNull();
		expect(await marker(other)).not.toBeNull();
	});

	test("editing or marking an existing item does not clear the marker", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });

		const before = await marker(group);

		const doc = await ListItem.findById(only._id);
		doc.quantity = 5;
		await doc.save();

		expect(String(await marker(group))).toBe(String(before));
	});

	test("a failure clearing the marker never fails the save", async () => {
		const { creator, group } = await setup();

		jest.spyOn(Group, "updateOne").mockRejectedValueOnce(new Error("db down"));

		const item = await makeItem(group, creator);

		expect(await ListItem.findById(item._id)).not.toBeNull();
	});
});


describe("concurrent operations", () => {

	test("Complete list pressed right after the last Found: no crash, never more than one notification round, marker cleared", async () => {
		for (let round = 0; round < 5; round++) {
			await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({}), ItemHistory.deleteMany({})]);
			fetchMock.mockClear();

			const { creator, admin, group } = await setup();
			const only = await makeItem(group, creator);

			const [found, done] = await Promise.all([
				setStatus(group, only, admin, { status: "found" }),
				(async () => { await new Promise((resolve) => setTimeout(resolve, round)); return completeList(group, creator); })(),
			]);

			await whenNotificationsIdle();

			expect(found.status).toBe(200);
			expect([200, 409]).toContain(done.status); // 409 if Complete list ran before the item was Found

			if (done.status === 200) {
				expect(await itemCount(group)).toBe(0);
				expect(await marker(group)).toBeNull();
			}

			expect(completedMessages().length).toBeLessThanOrEqual(2);
		}
	});

	test("an item added while the list is being completed stays on the new list and the marker ends cleared", async () => {
		for (let round = 0; round < 5; round++) {
			await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({}), ItemHistory.deleteMany({})]);

			const { creator, admin, group } = await setup();
			const only = await makeItem(group, creator);

			await mark(group, only, admin, { status: "found" });

			const [done, added] = await Promise.all([completeList(group, creator), addItem(group, creator)]);

			expect(done.status).toBe(200);
			expect(added.status).toBe(201);
			expect(await ListItem.findById(added.body.item.id)).not.toBeNull(); // not archived or deleted
			expect(await marker(group)).toBeNull();
		}
	});

	test("many Found requests for the last item send one notification round", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await Promise.all(Array.from({ length: 8 }, () => setStatus(group, only, admin, { status: "found" })));
		await whenNotificationsIdle();

		expect(completedMessages()).toHaveLength(2);
	});

	test("two trips back to back, each notifies exactly once", async () => {
		const { creator, admin, group } = await setup();

		for (let trip = 1; trip <= 3; trip++) {
			const added = trip === 1 ? await makeItem(group, creator) : { _id: (await addItem(group, creator)).body.item.id };

			await mark(group, added, admin, { status: "found" });
			expect(completedMessages()).toHaveLength(2 * trip);

			expect((await completeList(group, creator)).status).toBe(200);
		}
	});
});


describe("the other features still behave (US 16, US 18, US 22)", () => {

	test("US 16: undoing Found and marking it again notifies again; a plain second Found does not", async () => {
		const { creator, admin, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, admin, { status: "found" });
		await mark(group, only, admin, { status: "found" });
		expect(completedMessages()).toHaveLength(2);

		await mark(group, only, admin, { status: "pending" });
		expect(await marker(group)).toBeNull();

		await mark(group, only, admin, { status: "found" });
		expect(completedMessages()).toHaveLength(4);
	});

	test("US 18: adding an item still sends the items-added notification to the other members", async () => {
		const { creator, admin, group } = await setup();

		await addItem(group, creator);
		await whenNotificationsIdle();

		const tokens = allMessages().filter((m) => m.data.type === NOTIFICATION_TYPES.ITEMS_ADDED).map((m) => m.to).sort();

		expect(tokens).toEqual([tok(2), tok(5)]);
		expect(admin).toBeTruthy();
	});

	test("history: adding and replacing still record an addition row each", async () => {
		const { creator, admin, group } = await setup();
		const old = await makeItem(group, creator, { status: "notFound" });

		await addItem(group, creator);
		await replaceItem(group, old, admin);

		expect(await ItemHistory.countDocuments({ group: group._id, tripId: null })).toBe(2);
	});

	test("removing the last unresolved item never notifies, and the list can then be completed", async () => {
		const { creator, admin, group } = await setup();

		await makeItem(group, creator, { status: "found" });

		const open = await makeItem(group, creator, { catalogItemId: CATALOG_B });
		const removed = await request(app).delete(`/api/groups/${group._id}/items/${open._id}`).set("Authorization", tokenFor(admin));

		await whenNotificationsIdle();

		expect(removed.status).toBe(200);
		expect(completedMessages()).toHaveLength(0);
		expect((await completeList(group, creator)).status).toBe(200);
	});
});
