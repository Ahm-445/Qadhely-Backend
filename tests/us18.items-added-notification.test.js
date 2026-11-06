// US 18: Items Added to List Notification — tests (Jest + Supertest)
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
	notifyItemsAdded,
	notifyGroupMembers,
	isItemsAddedNotificationDue,
	whenNotificationsIdle,
	ITEMS_ADDED_WINDOW_MS,
	EXPO_BATCH_MAX,
	EXPO_PUSH_URL,
	NOTIFICATION_TYPES,
} = require("../src/services/pushNotifications");


// small app with only the group routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);


const MINUTE = 60 * 1000;
const realFetch = global.fetch;

let mongo;
let fetchMock;


// same token shape as the login response
const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

// "ExponentPushToken[0000000000000000000001]"
const tok = (n) => `ExponentPushToken[${String(n).padStart(22, "0")}]`;

let phoneCounter = 0;

async function makeUser(handleName, pushTokens = []) {
	phoneCounter += 1;
	return User.create({ handleName, phoneNumber: `+96655${String(phoneCounter).padStart(7, "0")}`, pushTokens });
}

// creator + admin (two phones) + member + a member with no phone registered, plus an outsider
async function setup() {
	const creator = await makeUser("Sara", [tok(1)]);
	const admin = await makeUser("Omar", [tok(2), tok(3)]);
	const member = await makeUser("Ali", [tok(4)]);
	const quiet = await makeUser("Huda", []);
	const outsider = await makeUser("Noura", [tok(9)]);

	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
			{ user: member._id, role: "member" },
			{ user: quiet._id, role: "member" },
		],
	});

	return { creator, admin, member, quiet, outsider, group };
}

const validItem = { catalogItemId: "tamimi-137805", quantity: 2, unit: "piece" };

const addItem = (groupId, user, body = validItem) => {
	const req = request(app).post(`/api/groups/${groupId}/items`);
	if (user) req.set("Authorization", tokenFor(user));
	return req.send(body);
};


// Expo's answer when everything is accepted: one "ok" ticket per message
const acceptAll = async (url, options) => {
	const messages = JSON.parse(options.body);
	return { ok: true, status: 200, json: async () => ({ data: messages.map(() => ({ status: "ok", id: "ticket" })) }) };
};

// Expo's answer with a chosen ticket per token: { [token]: ticket }, everything else "ok"
const answerWith = (ticketsByToken) => async (url, options) => {
	const messages = JSON.parse(options.body);
	return {
		ok: true,
		status: 200,
		json: async () => ({ data: messages.map((m) => ticketsByToken[m.to] || { status: "ok", id: "ticket" }) }),
	};
};

const deviceNotRegistered = { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };

const sentMessages = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));
const sentTokens = () => sentMessages().map((m) => m.to).sort();

const waitFor = async (condition, timeout = 3000) => {
	const end = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() > end) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
};

const pushTokensOf = async (user) => (await User.findById(user._id).lean()).pushTokens;
const lastAddedAt = async (group) => (await Group.findById(group._id).lean()).lastItemAddedAt;


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us18" });
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
	jest.spyOn(console, "log").mockImplementation(() => {});   // the auth middleware logs every token
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await whenNotificationsIdle();
	jest.restoreAllMocks();
});



describe("US18 AC-01 — the five-minute rule", () => {

	const now = new Date("2026-03-01T12:00:00.000Z");
	const ago = (ms) => new Date(now.getTime() - ms);

	test("the window is 5 minutes", () => {
		expect(ITEMS_ADDED_WINDOW_MS).toBe(5 * MINUTE);
	});

	test.each([[undefined], [null], ["not a date"]])("no usable previous addition (%p) qualifies", (previous) => {
		expect(isItemsAddedNotificationDue(previous, now)).toBe(true);
	});

	test("4 minutes 59.999 seconds after the last addition does not qualify", () => {
		expect(isItemsAddedNotificationDue(ago(5 * MINUTE - 1), now)).toBe(false);
	});

	test("exactly 5 minutes after the last addition does not qualify", () => {
		expect(isItemsAddedNotificationDue(ago(5 * MINUTE), now)).toBe(false);
	});

	test("5 minutes and 1 millisecond after the last addition qualifies", () => {
		expect(isItemsAddedNotificationDue(ago(5 * MINUTE + 1), now)).toBe(true);
	});

	test("an hour after the last addition qualifies", () => {
		expect(isItemsAddedNotificationDue(ago(60 * MINUTE), now)).toBe(true);
	});

	test("a last addition in the future (clock skew) does not qualify", () => {
		expect(isItemsAddedNotificationDue(new Date(now.getTime() + MINUTE), now)).toBe(false);
	});
});


describe("US18 AC-01 — deciding and recording the addition atomically", () => {

	const T0 = new Date("2026-03-01T12:00:00.000Z");
	const at = (ms) => new Date(T0.getTime() + ms);

	test("a new group has no last-addition time", async () => {
		const { group } = await setup();

		expect(await lastAddedAt(group)).toBeFalsy();
	});

	test("the very first addition qualifies, notifies, and records its time", async () => {
		const { group, creator } = await setup();

		const result = await notifyItemsAdded(group._id, creator._id, T0);

		expect(result).toMatchObject({ eligible: true, messages: 3 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(EXPO_PUSH_URL);
		expect(new Date(await lastAddedAt(group)).getTime()).toBe(T0.getTime());
	});

	test("exactly 5 minutes after the previous addition does not notify", async () => {
		const { group, creator } = await setup();
		await Group.updateOne({ _id: group._id }, { lastItemAddedAt: T0 });

		const result = await notifyItemsAdded(group._id, creator._id, at(5 * MINUTE));

		expect(result.eligible).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("5 minutes and 1 millisecond after the previous addition notifies", async () => {
		const { group, creator } = await setup();
		await Group.updateOne({ _id: group._id }, { lastItemAddedAt: T0 });

		const result = await notifyItemsAdded(group._id, creator._id, at(5 * MINUTE + 1));

		expect(result.eligible).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("every addition restarts the five minutes, even one that does not notify", async () => {
		const { group, creator } = await setup();

		expect((await notifyItemsAdded(group._id, creator._id, T0)).eligible).toBe(true);                  // first
		expect((await notifyItemsAdded(group._id, creator._id, at(4 * MINUTE))).eligible).toBe(false);     // 4 min after the first
		expect((await notifyItemsAdded(group._id, creator._id, at(8 * MINUTE))).eligible).toBe(false);     // 4 min after the second
		expect((await notifyItemsAdded(group._id, creator._id, at(14 * MINUTE))).eligible).toBe(true);     // 6 min after the third

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("the recorded time never moves backwards", async () => {
		const { group, creator } = await setup();
		await Group.updateOne({ _id: group._id }, { lastItemAddedAt: at(10 * MINUTE) });

		const result = await notifyItemsAdded(group._id, creator._id, at(1 * MINUTE));

		expect(result.eligible).toBe(false);
		expect(new Date(await lastAddedAt(group)).getTime()).toBe(at(10 * MINUTE).getTime());
	});

	test("recording an addition does not change the group's updatedAt", async () => {
		const { group, creator } = await setup();
		const oldUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
		await Group.collection.updateOne({ _id: group._id }, { $set: { updatedAt: oldUpdatedAt } });

		await notifyItemsAdded(group._id, creator._id, T0);

		const stored = await Group.findById(group._id).lean();

		expect(stored.updatedAt.getTime()).toBe(oldUpdatedAt.getTime());
		expect(stored.lastItemAddedAt.getTime()).toBe(T0.getTime());
	});

	test("an unknown group is ignored without an error", async () => {
		const { creator } = await setup();

		const result = await notifyItemsAdded(new mongoose.Types.ObjectId(), creator._id, T0);

		expect(result.eligible).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("ten additions at the same moment produce exactly one notification wave", async () => {
		const { group, creator } = await setup();

		const results = await Promise.all(Array.from({ length: 10 }, () => notifyItemsAdded(group._id, creator._id)));

		expect(results.filter((r) => r.eligible)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sentMessages()).toHaveLength(3);
		expect(new Set(sentTokens()).size).toBe(3);
	});

	test("the same window in two different groups notifies both", async () => {
		const a = await setup();
		const b = await setup();

		const [ra, rb] = await Promise.all([
			notifyItemsAdded(a.group._id, a.creator._id, T0),
			notifyItemsAdded(b.group._id, b.creator._id, T0),
		]);

		expect(ra.eligible).toBe(true);
		expect(rb.eligible).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});


describe("US18 — adding an item over HTTP", () => {

	test("the first item notifies the other members and keeps the existing 201 response", async () => {
		const { group, creator } = await setup();

		const res = await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(201);
		expect(res.body.message).toBe("Item added");
		expect(res.body.item).toMatchObject({
			groupId: String(group._id),
			catalogItemId: "tamimi-137805",
			quantity: 2,
			unit: "piece",
			addedBy: String(creator._id),
		});
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("the person who added the item is not notified, and neither are outsiders or phoneless members", async () => {
		const { group, creator, admin, member } = await setup();

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		const tokens = sentTokens();

		expect(tokens).toEqual([tok(2), tok(3), tok(4)].sort());   // admin's 2 phones + member's phone
		expect(tokens).not.toContain(tok(1));                      // the creator, who added it
		expect(tokens).not.toContain(tok(9));                      // outsider
		expect(String(admin._id)).not.toBe(String(member._id));
	});

	test("an admin who adds an item is excluded on every one of their phones", async () => {
		const { group, admin } = await setup();

		await addItem(group._id, admin);
		await whenNotificationsIdle();

		expect(sentTokens()).toEqual([tok(1), tok(4)].sort());
	});

	test("each recipient's notification carries the group, their own role and the member count (AC-02)", async () => {
		const { group, creator } = await setup();

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		const forAdmin = sentMessages().find((m) => m.to === tok(2));
		const forMember = sentMessages().find((m) => m.to === tok(4));

		expect(forAdmin.data).toEqual({
			type: NOTIFICATION_TYPES.ITEMS_ADDED,
			groupId: String(group._id),
			groupName: "Family groceries",
			myRole: "admin",
			memberCount: 4,
		});
		expect(forMember.data).toEqual({ ...forAdmin.data, myRole: "member" });
		expect(NOTIFICATION_TYPES.ITEMS_ADDED).toBe("items_added");
	});

	test("the message is addressed to the group, plays a sound and uses the app's Android channel", async () => {
		const { group, creator } = await setup();

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		for (const message of sentMessages()) {
			expect(message).toMatchObject({
				title: "Family groceries",
				body: "New items were added to the shopping list.",
				sound: "default",
				channelId: "default",
				priority: "high",
			});
		}
	});

	test("nothing private travels in the notification", async () => {
		const { group, creator } = await setup();

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		const wire = fetchMock.mock.calls.map(([, options]) => options.body).join("");

		expect(wire).not.toContain("+96655");     // phone numbers
		expect(wire).not.toContain("eyJ");        // a JWT
		expect(wire).not.toContain("test-secret");
	});

	test("a second item within 5 minutes does not notify again", async () => {
		const { group, creator } = await setup();

		await addItem(group._id, creator);
		await whenNotificationsIdle();
		fetchMock.mockClear();

		const second = await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(second.status).toBe(201);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

	test("an item added more than 5 minutes after the previous one notifies again", async () => {
		const { group, creator } = await setup();
		await Group.updateOne({ _id: group._id }, { lastItemAddedAt: new Date(Date.now() - 6 * MINUTE) });

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("an item added less than 5 minutes after the previous one does not notify", async () => {
		const { group, creator } = await setup();
		await Group.updateOne({ _id: group._id }, { lastItemAddedAt: new Date(Date.now() - 4 * MINUTE) });

		await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("six simultaneous additions all succeed and notify once", async () => {
		const { group, creator } = await setup();

		const responses = await Promise.all(Array.from({ length: 6 }, () => addItem(group._id, creator)));
		await whenNotificationsIdle();

		expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(6);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sentMessages()).toHaveLength(3);
	});

	test("the response does not wait for the push service", async () => {
		const { group, creator } = await setup();
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		fetchMock.mockImplementation(async (url, options) => { await gate; return acceptAll(url, options); });

		const res = await addItem(group._id, creator);   // resolves while Expo is still "thinking"

		await waitFor(() => fetchMock.mock.calls.length === 1);

		expect(res.status).toBe(201);
		release();
		await whenNotificationsIdle();
	});
});


describe("US18 — existing add-item rules are untouched (no notification, no timestamp)", () => {

	test("a regular member cannot add an item: 403, nothing stored, nobody notified", async () => {
		const { group, member } = await setup();

		const res = await addItem(group._id, member);
		await whenNotificationsIdle();

		expect(res.status).toBe(403);
		expect(await ListItem.countDocuments()).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeFalsy();
	});

	test("someone outside the group gets 403 and nothing happens", async () => {
		const { group, outsider } = await setup();

		const res = await addItem(group._id, outsider);
		await whenNotificationsIdle();

		expect(res.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeFalsy();
	});

	test("a request without a token gets 401 and nothing happens", async () => {
		const { group } = await setup();

		const res = await addItem(group._id, null);
		await whenNotificationsIdle();

		expect(res.status).toBe(401);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeFalsy();
	});

	test("an unknown group gets 404 and nothing happens", async () => {
		const { creator } = await setup();

		const res = await addItem(new mongoose.Types.ObjectId(), creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("a group id that is not an object id gets 400 and nothing happens", async () => {
		const { creator } = await setup();

		const res = await addItem("not-an-id", creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test.each([
		["a missing catalog id", { quantity: 2, unit: "piece" }],
		["a bad catalog id", { catalogItemId: "Not A Valid ID!", quantity: 2, unit: "piece" }],
		["a decimal quantity for pieces", { catalogItemId: "tamimi-137805", quantity: 1.5, unit: "piece" }],
		["a negative quantity", { catalogItemId: "tamimi-137805", quantity: -1, unit: "piece" }],
		["a quantity that is not a number", { catalogItemId: "tamimi-137805", quantity: "2", unit: "piece" }],
		["an unknown unit", { catalogItemId: "tamimi-137805", quantity: 2, unit: "litre" }],
	])("%s gets 400: nothing stored, nobody notified, no timestamp", async (_name, body) => {
		const { group, creator } = await setup();

		const res = await addItem(group._id, creator, body);
		await whenNotificationsIdle();

		expect(res.status).toBe(400);
		expect(await ListItem.countDocuments()).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeFalsy();
	});

	test("a decimal kg quantity is still accepted and notifies", async () => {
		const { group, creator } = await setup();

		const res = await addItem(group._id, creator, { catalogItemId: "tamimi-137805", quantity: 1.5, unit: "kg" });
		await whenNotificationsIdle();

		expect(res.status).toBe(201);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("if saving the item fails: 500, nobody is notified and the timestamp is not recorded", async () => {
		const { group, creator } = await setup();
		jest.spyOn(ListItem, "create").mockRejectedValueOnce(new Error("disk full"));

		const res = await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(500);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeFalsy();
	});
});


describe("US18 — a failing notification never fails the addition", () => {

	const expectItemAdded = async (group, creator) => {
		const res = await addItem(group._id, creator);
		await whenNotificationsIdle();

		expect(res.status).toBe(201);
		expect(res.body.message).toBe("Item added");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	};

	test("Expo is unreachable (network error)", async () => {
		const { group, creator } = await setup();
		fetchMock.mockRejectedValue(new Error("network down"));

		await expectItemAdded(group, creator);

		expect(console.error).toHaveBeenCalled();
	});

	test("Expo answers with an HTTP error", async () => {
		const { group, creator } = await setup();
		fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ errors: [{ message: "boom" }] }) });

		await expectItemAdded(group, creator);
	});

	test("Expo answers with something that is not JSON", async () => {
		const { group, creator } = await setup();
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("not json"); } });

		await expectItemAdded(group, creator);
	});

	test("Expo answers with no tickets at all", async () => {
		const { group, creator } = await setup();
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

		await expectItemAdded(group, creator);

		// no ticket means no proof a token is dead, so nobody loses a token
		expect(await pushTokensOf(await User.findOne({ handleName: "Omar" }))).toEqual([tok(2), tok(3)]);
	});

	test("the database fails while looking up the members' phones", async () => {
		const { group, creator } = await setup();
		jest.spyOn(User, "find").mockImplementationOnce(() => { throw new Error("db down"); });

		await expectItemAdded(group, creator);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("the database fails while recording the addition time", async () => {
		const { group, creator } = await setup();
		jest.spyOn(Group, "findOneAndUpdate").mockRejectedValueOnce(new Error("db down"));

		await expectItemAdded(group, creator);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("notifyItemsAdded itself never rejects", async () => {
		const { group, creator } = await setup();
		fetchMock.mockRejectedValue(new Error("network down"));

		await expect(notifyItemsAdded(group._id, creator._id)).resolves.toMatchObject({ eligible: true });
	});

	test("a bad group id never rejects either", async () => {
		await expect(notifyItemsAdded("not-an-id", "also-not-an-id")).resolves.toMatchObject({ eligible: false, failed: true });
	});
});


describe("US18 — who receives the notification", () => {

	test("every member's every phone is notified, once", async () => {
		const { group, creator } = await setup();

		await notifyItemsAdded(group._id, creator._id);

		expect(sentTokens()).toEqual([tok(2), tok(3), tok(4)].sort());
	});

	test("a token registered on two members is sent to only once", async () => {
		const { group, creator, member } = await setup();
		await User.updateOne({ _id: member._id }, { $set: { pushTokens: [tok(2)] } });   // the admin's phone too

		await notifyItemsAdded(group._id, creator._id);

		expect(sentTokens()).toEqual([tok(2), tok(3)].sort());
	});

	test("a token listed twice for one member is sent to only once", async () => {
		const { group, creator, member } = await setup();
		await User.collection.updateOne({ _id: member._id }, { $set: { pushTokens: [tok(4), tok(4), tok(4)] } });

		await notifyItemsAdded(group._id, creator._id);

		expect(sentMessages().filter((m) => m.to === tok(4))).toHaveLength(1);
	});

	test("values that are not Expo push tokens are skipped", async () => {
		const { group, creator, member } = await setup();
		await User.collection.updateOne(
			{ _id: member._id },
			{ $set: { pushTokens: ["not-a-token", "", "ExponentPushToken[]", tok(4)] } }
		);

		await notifyItemsAdded(group._id, creator._id);

		expect(sentTokens()).toEqual([tok(2), tok(3), tok(4)].sort());
	});

	test("a member whose account no longer exists is skipped, the others are still notified", async () => {
		const { group, creator, member } = await setup();
		await User.deleteOne({ _id: member._id });

		const result = await notifyItemsAdded(group._id, creator._id);

		expect(result.eligible).toBe(true);
		expect(sentTokens()).toEqual([tok(2), tok(3)].sort());
	});

	test("a group of one person sends nothing, but still records the addition", async () => {
		const solo = await makeUser("Solo", [tok(5)]);
		const group = await Group.create({ name: "Just me", createdBy: solo._id, members: [{ user: solo._id, role: "creator" }] });

		const result = await notifyItemsAdded(group._id, solo._id);

		expect(result).toMatchObject({ eligible: true, messages: 0 });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await lastAddedAt(group)).toBeTruthy();
	});

	test("nobody having a registered phone sends nothing", async () => {
		const { group, creator } = await setup();
		await User.updateMany({}, { $set: { pushTokens: [] } });

		await notifyItemsAdded(group._id, creator._id);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("members of other groups are never notified", async () => {
		const mine = await setup();
		const other = await setup();

		await notifyItemsAdded(mine.group._id, mine.creator._id);

		expect(sentTokens()).not.toContain(tok(1));
		expect(String(other.group._id)).not.toBe(String(mine.group._id));
	});

	test("notifyGroupMembers accepts plain data as well as a function", async () => {
		const { group, creator } = await setup();
		const plain = (await Group.findById(group._id).lean());

		await notifyGroupMembers(plain, creator._id, { title: "T", body: "B", data: { hello: "world" } });
		await notifyGroupMembers(plain, creator._id, { title: "T", body: "B", data: (m) => ({ role: m.role }) });

		const [first, second] = fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body));

		expect(first[0].data).toEqual({ hello: "world" });
		expect(second.find((m) => m.to === tok(2)).data).toEqual({ role: "admin" });
	});
});


describe("US18 — tokens Expo says are dead are cleaned up", () => {

	test("a DeviceNotRegistered token is removed from the member who held it, and only that one", async () => {
		const { group, creator, admin, member } = await setup();
		fetchMock.mockImplementation(answerWith({ [tok(3)]: deviceNotRegistered }));

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(admin)).toEqual([tok(2)]);
		expect(await pushTokensOf(member)).toEqual([tok(4)]);
	});

	test("dead tokens of several members are all removed", async () => {
		const { group, creator, admin, member } = await setup();
		fetchMock.mockImplementation(answerWith({ [tok(2)]: deviceNotRegistered, [tok(4)]: deviceNotRegistered }));

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(admin)).toEqual([tok(3)]);
		expect(await pushTokensOf(member)).toEqual([]);
	});

	test("the right token is matched to the right ticket", async () => {
		const { group, creator, admin, member } = await setup();
		// message order is: admin's tok(2), tok(3), then member's tok(4); only the middle one is dead
		fetchMock.mockImplementation(answerWith({ [tok(3)]: deviceNotRegistered }));

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(admin)).toEqual([tok(2)]);
		expect(await pushTokensOf(member)).toEqual([tok(4)]);
	});

	test.each([
		["MessageRateExceeded", { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }],
		["InvalidCredentials", { status: "error", message: "bad key", details: { error: "InvalidCredentials" } }],
		["MessageTooBig", { status: "error", message: "big", details: { error: "MessageTooBig" } }],
		["an error without details", { status: "error", message: "unknown" }],
	])("%s is logged, but the token is kept", async (_name, ticket) => {
		const { group, creator, admin } = await setup();
		fetchMock.mockImplementation(answerWith({ [tok(2)]: ticket }));

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(admin)).toEqual([tok(2), tok(3)]);
		expect(console.error).toHaveBeenCalled();
	});

	test("the person who added the item is never sent to, so their tokens are never touched", async () => {
		const { group, creator } = await setup();
		fetchMock.mockImplementation(answerWith({ [tok(1)]: deviceNotRegistered }));

		await notifyItemsAdded(group._id, creator._id);

		expect(sentTokens()).not.toContain(tok(1));
		expect(await pushTokensOf(creator)).toEqual([tok(1)]);
	});

	test("fewer tickets than messages does not remove or crash anything", async () => {
		const { group, creator, admin } = await setup();
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ status: "ok" }] }) });

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(admin)).toEqual([tok(2), tok(3)]);
	});
});


describe("US18 — batches of 100", () => {

	// the creator plus `count` members, each with two phones: 2 * count tokens
	async function bigGroup(count) {
		const creator = await makeUser("Boss", [tok(0)]);

		const members = await User.insertMany(Array.from({ length: count }, (_, i) => ({
			handleName: `member${i}`,
			phoneNumber: `+97766${String(i).padStart(7, "0")}`,
			pushTokens: [tok(1000 + i * 2), tok(1001 + i * 2)],
		})));

		const group = await Group.create({
			name: "Big family",
			createdBy: creator._id,
			members: [{ user: creator._id, role: "creator" }, ...members.map((m) => ({ user: m._id, role: "member" }))],
		});

		return { creator, members, group };
	}

	test("250 phones are sent in batches of 100, 100 and 50", async () => {
		const { group, creator } = await bigGroup(125);

		await notifyItemsAdded(group._id, creator._id);

		expect(EXPO_BATCH_MAX).toBe(100);
		expect(fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body).length)).toEqual([100, 100, 50]);
		expect(new Set(sentTokens()).size).toBe(250);
	});

	test("exactly 100 phones are one batch, 101 are two", async () => {
		const exact = await bigGroup(50);
		await notifyItemsAdded(exact.group._id, exact.creator._id);
		expect(fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body).length)).toEqual([100]);

		await Promise.all([User.deleteMany({}), Group.deleteMany({})]);
		fetchMock.mockClear();

		const over = await bigGroup(50);
		await User.updateOne({ _id: over.members[0]._id }, { $push: { pushTokens: tok(5000) } });
		await notifyItemsAdded(over.group._id, over.creator._id);
		expect(fetchMock.mock.calls.map(([, o]) => JSON.parse(o.body).length)).toEqual([100, 1]);
	});

	test("a dead token in the middle batch is removed from the right member", async () => {
		const { group, creator, members } = await bigGroup(125);
		const deadToken = tok(1000 + 70 * 2);   // member 70: his first phone is in the second batch
		fetchMock.mockImplementation(answerWith({ [deadToken]: deviceNotRegistered }));

		await notifyItemsAdded(group._id, creator._id);

		expect(await pushTokensOf(members[70])).toEqual([tok(1001 + 70 * 2)]);
		expect(await pushTokensOf(members[71])).toEqual([tok(1000 + 71 * 2), tok(1001 + 71 * 2)]);
	});

	test("a batch Expo rejects does not stop the others, and its tokens are kept", async () => {
		const { group, creator, members } = await bigGroup(125);
		let call = 0;
		fetchMock.mockImplementation(async (url, options) => {
			call += 1;
			if (call === 2) return { ok: false, status: 500, json: async () => ({}) };
			return acceptAll(url, options);
		});

		const result = await notifyItemsAdded(group._id, creator._id);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result.eligible).toBe(true);
		expect(await pushTokensOf(members[70])).toHaveLength(2);
	});

	test("a batch that fails on the network does not stop the others either", async () => {
		const { group, creator } = await bigGroup(125);
		let call = 0;
		fetchMock.mockImplementation(async (url, options) => {
			call += 1;
			if (call === 1) throw new Error("connection reset");
			return acceptAll(url, options);
		});

		await notifyItemsAdded(group._id, creator._id);

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
