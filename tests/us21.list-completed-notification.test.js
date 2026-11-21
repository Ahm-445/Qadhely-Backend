// US 21: List Completed Notification — tests (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.
// Expo's push service is replaced by a mock: these tests never send a real notification.

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
const {
	notifyListCompleted,
	notifyGroupMembers,
	isListComplete,
	resetListCompleted,
	whenNotificationsIdle,
	NOTIFICATION_TYPES,
} = require("../src/services/pushNotifications");


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

async function makeUser(handleName, pushTokens = []) {
	phoneCounter += 1;
	return User.create({ handleName, phoneNumber: `+96655${String(phoneCounter).padStart(7, "0")}`, pushTokens });
}

// creator Sara (1 phone), admins Omar (2 phones) and Layla (1 phone), members Ali and Huda (phones), Noura outside
async function setup() {
	const creator = await makeUser("Sara", [tok(1)]);
	const admin = await makeUser("Omar", [tok(2), tok(3)]);
	const admin2 = await makeUser("Layla", [tok(4)]);
	const member = await makeUser("Ali", [tok(5)]);
	const member2 = await makeUser("Huda", [tok(6)]);
	const outsider = await makeUser("Noura", [tok(9)]);

	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
			{ user: admin2._id, role: "admin" },
			{ user: member._id, role: "member" },
			{ user: member2._id, role: "member" },
		],
	});

	return { creator, admin, admin2, member, member2, outsider, group };
}

const CATALOG_A = "tamimi-1196";
const CATALOG_B = "tamimi-154850";

const makeItem = (group, user, fields = {}) => ListItem.create({
	group: group._id, catalogItemId: CATALOG_A, quantity: 1, unit: "piece", addedBy: user._id, ...fields,
});

const setStatus = (groupId, itemId, user, body) =>
	request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`).set("Authorization", tokenFor(user)).send(body);

const addItem = (groupId, user) =>
	request(app).post(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user)).send({ catalogItemId: CATALOG_B, quantity: 2, unit: "piece" });

const removeItem = (groupId, itemId, user) =>
	request(app).delete(`/api/groups/${groupId}/items/${itemId}`).set("Authorization", tokenFor(user));

const replaceItem = (groupId, itemId, user) =>
	request(app).post(`/api/groups/${groupId}/items/${itemId}/replace`).set("Authorization", tokenFor(user)).send({ catalogItemId: CATALOG_B, quantity: 1, unit: "piece" });

const acceptAll = async (url, options) => {
	const messages = JSON.parse(options.body);
	return { ok: true, status: 200, json: async () => ({ data: messages.map(() => ({ status: "ok", id: "ticket" })) }) };
};

const allMessages = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));
const completedMessages = () => allMessages().filter((m) => m.data.type === NOTIFICATION_TYPES.LIST_COMPLETED);
const completedTokens = () => completedMessages().map((m) => m.to).sort();

const marker = async (group) => (await Group.findById(group._id).lean()).listCompletedNotifiedAt;

// a status change followed by the background notification job
const mark = async (group, item, user, body) => {
	const res = await setStatus(group._id, item._id, user, body);
	await whenNotificationsIdle();
	return res;
};

const ADMIN_TOKENS = [tok(1), tok(2), tok(3), tok(4)];


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us21" });
	await Promise.all([User.init(), Group.init(), ListItem.init()]);
});

afterAll(async () => {
	global.fetch = realFetch;
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
	fetchMock = jest.fn(acceptAll);
	global.fetch = fetchMock;
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});


describe("US 21 AC-01 — the last item marked found completes the list", () => {

	test("a member marks the final item found: creator and admins are notified, regular members are not", async () => {
		const { creator, member, group } = await setup();
		const a = await makeItem(group, creator, { status: "found" });
		const b = await makeItem(group, creator);

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
		expect(a).toBeTruthy();
	});

	test("the message: group name as title, completion text, high priority on the app's channel", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedMessages()[0]).toMatchObject({
			title: "Family groceries",
			body: "The shopping list is completed.",
			sound: "default",
			channelId: "default",
			priority: "high",
		});
	});

	test("every recipient's data carries the group, their own role and the member count", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		const byToken = Object.fromEntries(completedMessages().map((m) => [m.to, m.data]));
		const base = { type: "list_completed", groupId: String(group._id), groupName: "Family groceries", memberCount: 5 };

		expect(byToken[tok(1)]).toEqual({ ...base, myRole: "creator" });
		expect(byToken[tok(2)]).toEqual({ ...base, myRole: "admin" });
		expect(byToken[tok(3)]).toEqual({ ...base, myRole: "admin" });
		expect(byToken[tok(4)]).toEqual({ ...base, myRole: "admin" });
	});

	test("an admin who marks the final item is notified too", async () => {
		const { creator, admin, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, admin, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("the creator who marks the final item is notified too", async () => {
		const { creator, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, creator, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("a user is notified once per device and never twice", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedTokens()).toEqual([...new Set(completedTokens())]);
		expect(completedMessages()).toHaveLength(4);
	});

	test("the status update's response is unchanged", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		const res = await mark(group, b, member, { status: "found" });

		expect(res.body.message).toBe("Item status updated");
		expect(res.body.item).toMatchObject({ id: String(b._id), groupId: String(group._id), status: "found", statusUpdatedBy: String(member._id) });
	});

	test("the list is complete only after the final item: earlier found marks send nothing", async () => {
		const { creator, member, group } = await setup();
		const a = await makeItem(group, creator);
		const b = await makeItem(group, creator);
		const c = await makeItem(group, creator);

		await mark(group, a, member, { status: "found" });
		await mark(group, b, member, { status: "found" });
		expect(completedMessages()).toHaveLength(0);

		await mark(group, c, member, { status: "found" });
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("a single-item list completes when that item is found", async () => {
		const { creator, member, group } = await setup();
		const only = await makeItem(group, creator);

		await mark(group, only, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

});


describe("US 21 — what blocks completion", () => {

	test("a pending item left on the list", async () => {
		const { creator, member, group } = await setup();
		await makeItem(group, creator);
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedMessages()).toHaveLength(0);
		expect(await marker(group)).toBeNull();
	});

	test("a not-found item left on the list", async () => {
		const { creator, member, group } = await setup();
		await makeItem(group, creator, { status: "notFound" });
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedMessages()).toHaveLength(0);
	});

	test("marking an item not found never notifies", async () => {
		const { creator, member, group } = await setup();
		await makeItem(group, creator, { status: "found" });
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "notFound" });

		expect(completedMessages()).toHaveLength(0);
	});

	test("an item saved before US 16 (no status) counts as pending", async () => {
		const { creator, member, group } = await setup();
		await ListItem.collection.insertOne({ group: group._id, catalogItemId: CATALOG_A, quantity: 1, unit: "piece", addedBy: creator._id, createdAt: new Date(), updatedAt: new Date() });
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedMessages()).toHaveLength(0);
	});

	test("an empty list never completes", async () => {
		const { group } = await setup();

		expect(await isListComplete(group._id)).toBe(false);

		await notifyListCompleted(group._id);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(await marker(group)).toBeNull();
	});

	test("items of another group do not count", async () => {
		const { creator, member, group } = await setup();
		const other = await Group.create({ name: "Other", createdBy: creator._id, members: [{ user: creator._id, role: "creator" }] });
		await makeItem(other, creator);
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

});


describe("US 21 — replaced items", () => {

	test("a replaced item is resolved when its replacement is found", async () => {
		const { creator, admin, member, group } = await setup();
		await makeItem(group, creator, { status: "found" });
		const old = await makeItem(group, creator, { status: "notFound" });

		const replaced = await replaceItem(group._id, old._id, admin);
		expect(replaced.status).toBe(201);

		await mark(group, { _id: replaced.body.item.id }, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("a pending replacement keeps the list open", async () => {
		const { creator, admin, member, group } = await setup();
		const a = await makeItem(group, creator);
		const old = await makeItem(group, creator, { status: "notFound" });

		await replaceItem(group._id, old._id, admin);
		await mark(group, a, member, { status: "found" });

		expect(completedMessages()).toHaveLength(0);
	});

	test("a list with only a replaced item and no replacement is not complete (no found item)", async () => {
		const { creator, group } = await setup();
		await makeItem(group, creator, { status: "replaced", replacedBy: new mongoose.Types.ObjectId(), statusUpdatedAt: new Date(0) });

		expect(await isListComplete(group._id)).toBe(false);
	});

	test("a replacement that was removed later no longer blocks (once the replacement window has passed)", async () => {
		const { creator, group } = await setup();
		await makeItem(group, creator, { status: "found" });
		await makeItem(group, creator, { status: "replaced", replacedBy: new mongoose.Types.ObjectId(), statusUpdatedAt: new Date(Date.now() - 60 * 1000) });

		expect(await isListComplete(group._id)).toBe(true);
	});

	test("an item replaced a moment ago whose replacement is not saved yet is still open", async () => {
		const { creator, group } = await setup();
		await makeItem(group, creator, { status: "found" });
		await makeItem(group, creator, { status: "replaced", replacedBy: new mongoose.Types.ObjectId(), statusUpdatedAt: new Date() });

		expect(await isListComplete(group._id)).toBe(false);
	});

});


describe("US 21 — one notification per completion", () => {

	test("marking an already found item found again sends nothing more", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });
		fetchMock.mockClear();

		const again = await mark(group, b, member, { status: "found" });

		expect(again.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("the marker is stored when the notification goes out", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);

		await mark(group, b, member, { status: "found" });

		expect(await marker(group)).toBeInstanceOf(Date);
	});

	test("ten claims at once send exactly one notification", async () => {
		const { creator, group } = await setup();
		await makeItem(group, creator, { status: "found" });

		await Promise.all(Array.from({ length: 10 }, () => notifyListCompleted(group._id)));

		expect(completedMessages()).toHaveLength(4);
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("two members marking the last two items at the same time send exactly one notification", async () => {
		for (let round = 0; round < 5; round += 1) {
			fetchMock.mockClear();
			await Promise.all([Group.deleteMany({}), ListItem.deleteMany({}), User.deleteMany({})]);

			const { creator, member, member2, group } = await setup();
			await makeItem(group, creator, { status: "found" });
			const b = await makeItem(group, creator);
			const c = await makeItem(group, creator);

			const results = await Promise.all([
				setStatus(group._id, b._id, member, { status: "found" }),
				setStatus(group._id, c._id, member2, { status: "found" }),
			]);
			await whenNotificationsIdle();

			expect(results.map((r) => r.status)).toEqual([200, 200]);
			expect(completedMessages()).toHaveLength(4);
		}
	});

	test("an item added while the last item is being marked is never reported as completed", async () => {
		const { creator, admin, member, group } = await setup();
		const b = await makeItem(group, creator);

		// the new item is saved after the completion is claimed and before it is confirmed
		const original = Group.findOneAndUpdate.bind(Group);
		jest.spyOn(Group, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
			const claimed = await original(...args);
			await makeItem(group, creator);
			return claimed;
		});

		await mark(group, b, member, { status: "found" });

		expect(completedMessages()).toHaveLength(0);
		expect(await marker(group)).toBeNull();
		expect(admin).toBeTruthy();
	});

	test("the list can complete again afterwards even if that happened", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		const original = Group.findOneAndUpdate.bind(Group);
		let extra;
		jest.spyOn(Group, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
			const claimed = await original(...args);
			extra = await makeItem(group, creator);
			return claimed;
		});

		await mark(group, b, member, { status: "found" });
		await mark(group, extra, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

});


describe("US 21 — the list is reopened and completed again", () => {

	async function completedList() {
		const ctx = await setup();
		const a = await makeItem(ctx.group, ctx.creator);
		const b = await makeItem(ctx.group, ctx.creator);

		await mark(ctx.group, a, ctx.member, { status: "found" });
		await mark(ctx.group, b, ctx.member, { status: "found" });
		expect(completedMessages()).toHaveLength(4);
		fetchMock.mockClear();

		return { ...ctx, a, b };
	}

	test("undoing a mark (pending) clears the marker, and finding it again notifies again", async () => {
		const { group, a, member } = await completedList();

		await mark(group, a, member, { status: "pending" });
		expect(await marker(group)).toBeNull();
		expect(completedMessages()).toHaveLength(0);

		await mark(group, a, member, { status: "found" });
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("marking a found item not found clears the marker, and completing again notifies again", async () => {
		const { group, a, member } = await completedList();

		await mark(group, a, member, { status: "notFound", replacementText: "something else" });
		expect(await marker(group)).toBeNull();

		await mark(group, a, member, { status: "found" });
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("adding an item clears the marker, and completing the new item notifies again", async () => {
		const { group, creator, member } = await completedList();

		const added = await addItem(group._id, creator);
		expect(added.status).toBe(201);
		expect(await marker(group)).toBeNull();
		await whenNotificationsIdle();
		fetchMock.mockClear();

		await mark(group, { _id: added.body.item.id }, member, { status: "found" });
		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("replacing an item clears the marker", async () => {
		const { group, a, admin, creator } = await completedList();
		await ListItem.updateOne({ _id: a._id }, { $set: { status: "notFound" } });
		await Group.updateOne({ _id: group._id }, { $set: { listCompletedNotifiedAt: new Date() } });

		const res = await replaceItem(group._id, a._id, admin);

		expect(res.status).toBe(201);
		expect(await marker(group)).toBeNull();
		expect(creator).toBeTruthy();
	});

	test("without a change the list is not announced again by a later status call on another item", async () => {
		const { group, a, b, member } = await completedList();

		await mark(group, a, member, { status: "found" });
		await mark(group, b, member, { status: "found" });

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("resetListCompleted only clears the marker", async () => {
		const { group } = await setup();
		await Group.updateOne({ _id: group._id }, { $set: { listCompletedNotifiedAt: new Date() } });
		const before = await Group.findById(group._id).lean();

		await resetListCompleted(group._id);

		const after = await Group.findById(group._id).lean();
		expect(after.listCompletedNotifiedAt).toBeNull();
		expect(String(after.updatedAt)).toBe(String(before.updatedAt));
	});

});


describe("US 21 — removing items", () => {

	test("removing the last incomplete item does not send a completion notification", async () => {
		const { creator, group } = await setup();
		await makeItem(group, creator, { status: "found" });
		const pending = await makeItem(group, creator);

		const res = await removeItem(group._id, pending._id, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(200);
		expect(completedMessages()).toHaveLength(0);
		expect(await marker(group)).toBeNull();
	});

	test("a removed item no longer blocks the next completion", async () => {
		const { creator, member, group } = await setup();
		const a = await makeItem(group, creator);
		const b = await makeItem(group, creator);

		await removeItem(group._id, b._id, creator);
		await mark(group, a, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

});


describe("US 21 — delivery problems never affect the status update", () => {

	test("Expo unreachable: the update succeeds and is saved", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		fetchMock.mockImplementation(async () => { throw new Error("network down"); });

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
		expect((await ListItem.findById(b._id).lean()).status).toBe("found");
	});

	test("Expo answers with an error: the update succeeds", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
	});

	test("Expo sends back something unreadable: the update succeeds", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }));

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
	});

	test("the group lookup of the notifier fails: the update succeeds", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		jest.spyOn(Group, "findOneAndUpdate").mockRejectedValueOnce(new Error("db down"));

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
		expect((await ListItem.findById(b._id).lean()).status).toBe("found");
	});

	test("the completion check fails: the update succeeds", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		jest.spyOn(ListItem, "find").mockImplementationOnce(() => ({ select: () => ({ lean: async () => { throw new Error("db down"); } }) }));

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
	});

	test("a failed send gives the completion back no marker problems: the next completion still works", async () => {
		const { creator, member, group } = await setup();
		const b = await makeItem(group, creator);
		jest.spyOn(ListItem, "find").mockImplementationOnce(() => ({ select: () => ({ lean: async () => { throw new Error("db down"); } }) }));

		await mark(group, b, member, { status: "found" });
		await mark(group, b, member, { status: "pending" });
		await mark(group, b, member, { status: "found" });

		expect(completedTokens()).toEqual(ADMIN_TOKENS);
	});

	test("admins without a registered phone: nothing is sent and the update succeeds", async () => {
		const { creator, member, group } = await setup();
		await User.updateMany({}, { $set: { pushTokens: [] } });
		const b = await makeItem(group, creator);

		const res = await mark(group, b, member, { status: "found" });

		expect(res.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("an invalid or unauthorized status request sends nothing", async () => {
		const { creator, outsider, member, group } = await setup();
		const b = await makeItem(group, creator);

		const outsiderRes = await setStatus(group._id, b._id, outsider, { status: "found" });
		const badRes = await setStatus(group._id, b._id, member, { status: "done" });
		await whenNotificationsIdle();

		expect(outsiderRes.status).toBe(403);
		expect(badRes.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await ListItem.findById(b._id).lean()).status).toBe("pending");
	});

	test("dead devices are removed, as for every notification", async () => {
		const { creator, admin, member, group } = await setup();
		const b = await makeItem(group, creator);
		fetchMock.mockImplementation(async (url, options) => {
			const messages = JSON.parse(options.body);
			return { ok: true, status: 200, json: async () => ({ data: messages.map((m) => (m.to === tok(2) ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" })) }) };
		});

		await mark(group, b, member, { status: "found" });

		expect((await User.findById(admin._id).lean()).pushTokens).toEqual([tok(3)]);
	});

});


describe("US 21 — existing behaviour is preserved", () => {

	test("US 18: adding an item still sends the items-added notification", async () => {
		const { creator, member, group } = await setup();

		const res = await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(201);
		const added = allMessages().filter((m) => m.data.type === "items_added");
		expect(added.map((m) => m.to).sort()).toEqual([tok(2), tok(3), tok(4), tok(5), tok(6)]);
		expect(member).toBeTruthy();
	});

	test("notifyGroupMembers without a role filter still reaches every member", async () => {
		const { creator, group } = await setup();
		const plain = await Group.findById(group._id).lean();

		await notifyGroupMembers(plain, creator._id, { title: "t", body: "b", data: { type: "x" } });

		expect(allMessages().map((m) => m.to).sort()).toEqual([tok(2), tok(3), tok(4), tok(5), tok(6)]);
	});

	test("notifyGroupMembers with roles reaches only those roles", async () => {
		const { group } = await setup();
		const plain = await Group.findById(group._id).lean();

		await notifyGroupMembers(plain, null, { title: "t", body: "b", data: { type: "x" }, roles: ["admin"] });

		expect(allMessages().map((m) => m.to).sort()).toEqual([tok(2), tok(3), tok(4)]);
	});

	test("the notification type is exported", () => {
		expect(NOTIFICATION_TYPES.LIST_COMPLETED).toBe("list_completed");
	});

	test("marking found, not found and pending still saves the item's status and replacement text", async () => {
		const { creator, member, group } = await setup();
		await makeItem(group, creator);
		const b = await makeItem(group, creator);

		const notFound = await setStatus(group._id, b._id, member, { status: "notFound", replacementText: "  Low fat  " });
		expect(notFound.body.item).toMatchObject({ status: "notFound", replacementText: "Low fat" });

		const pending = await setStatus(group._id, b._id, member, { status: "pending" });
		expect(pending.body.item).toMatchObject({ status: "pending", replacementText: null });
	});

});
