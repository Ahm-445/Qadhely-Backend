// Item removed / item modified notifications — API tests (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.
// The Expo push service is not called: global fetch is mocked and the sent messages are inspected.

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const Item = require("../src/models/Item");
const { EXPO_PUSH_URL } = require("../src/services/pushNotifications");


// small app with only the group routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);


let mongo;
let fetchMock;
const realFetch = global.fetch;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

// Expo answers with one "ok" ticket per message unless a test says otherwise
function expoReplies(ticketFor = () => ({ status: "ok", id: "ticket" })) {
	fetchMock.mockImplementation(async (url, options) => {
		const messages = JSON.parse(options.body);
		return { ok: true, status: 200, json: async () => ({ data: messages.map((m) => ticketFor(m)) }) };
	});
}

// all messages sent to Expo so far
const sentMessages = () => fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));

// notifications are sent in the background, after the response
async function waitFor(check, timeout = 2000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeout) throw new Error("timed out waiting");
		await new Promise((r) => setTimeout(r, 10));
	}
}
const settle = () => new Promise((r) => setTimeout(r, 150));


// Sara edits the list; Omar and Ali are the other members; Noura is outside the group
async function setup() {
	const [sara, omar, ali, noura] = await User.insertMany([
		{ handleName: "Sara", phoneNumber: "+966550000001", pushTokens: ["ExponentPushToken[sara]"] },
		{ handleName: "Omar", phoneNumber: "+966550000002", pushTokens: ["ExponentPushToken[omar-1]", "ExponentPushToken[omar-2]"] },
		{ handleName: "Ali", phoneNumber: "+966550000003", pushTokens: ["ExponentPushToken[ali]"] },
		{ handleName: "Noura", phoneNumber: "+966550000004", pushTokens: ["ExponentPushToken[noura]"] },
	]);

	const group = await Group.create({
		name: "Family groceries",
		createdBy: sara._id,
		members: [
			{ user: sara._id, role: "creator" },
			{ user: omar._id, role: "member" },
			{ user: ali._id, role: "admin" },
		],
	});

	const milk = await Item.create({ group: group._id, name: "Milk", quantity: 2, unit: "L", addedBy: sara._id });
	const eggs = await Item.create({ group: group._id, name: "Eggs", quantity: 12, unit: "pcs", addedBy: omar._id });

	return { sara, omar, ali, noura, group, milk, eggs };
}

const removeItem = (group, item, user) => request(app)
	.delete(`/api/groups/${group._id}/items/${item._id}`)
	.set("Authorization", tokenFor(user));

const updateItem = (group, item, user, body) => request(app)
	.patch(`/api/groups/${group._id}/items/${item._id}`)
	.set("Authorization", tokenFor(user))
	.send(body);


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_item_notifications" });
});

afterAll(async () => {
	global.fetch = realFetch;
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	fetchMock = jest.fn();
	global.fetch = fetchMock;
	expoReplies();
	jest.spyOn(console, "log").mockImplementation(() => {});
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), Item.deleteMany({})]);
});

afterEach(() => {
	jest.restoreAllMocks();
});



describe("Item removed — AC-01 (members are notified with the exact item name)", () => {

	test("removes the item from the list", async () => {
		const { sara, group, milk } = await setup();

		const res = await removeItem(group, milk, sara);

		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ id: String(milk._id), name: "Milk" });
		expect(await Item.exists({ _id: milk._id })).toBeNull();
		expect(await Item.countDocuments({ group: group._id })).toBe(1);
	});

	test("every other member's phone gets a notification naming the removed item", async () => {
		const { sara, group, milk } = await setup();

		await removeItem(group, milk, sara);
		await waitFor(() => fetchMock.mock.calls.length > 0);

		expect(fetchMock.mock.calls[0][0]).toBe(EXPO_PUSH_URL);

		const messages = sentMessages();
		expect(messages.map((m) => m.to).sort()).toEqual([
			"ExponentPushToken[ali]",
			"ExponentPushToken[omar-1]",
			"ExponentPushToken[omar-2]",
		]);

		for (const m of messages) {
			expect(m.title).toBe("Family groceries");
			expect(m.body).toContain("Milk");
			expect(m.body).toMatch(/removed/i);
			expect(m.data).toMatchObject({ type: "item_removed", itemName: "Milk", itemId: String(milk._id) });
		}
	});

	test("the member who removed the item and people outside the group are not notified", async () => {
		const { sara, group, milk } = await setup();

		await removeItem(group, milk, sara);
		await waitFor(() => fetchMock.mock.calls.length > 0);

		const tokens = sentMessages().map((m) => m.to);
		expect(tokens).not.toContain("ExponentPushToken[sara]");
		expect(tokens).not.toContain("ExponentPushToken[noura]");
	});

	test("members who are logged out everywhere (no push tokens) are skipped", async () => {
		const { sara, omar, group, milk } = await setup();
		await User.updateOne({ _id: omar._id }, { pushTokens: [] });

		await removeItem(group, milk, sara);
		await waitFor(() => fetchMock.mock.calls.length > 0);

		expect(sentMessages().map((m) => m.to)).toEqual(["ExponentPushToken[ali]"]);
	});

	test("tokens Expo reports as DeviceNotRegistered are unlinked from the user", async () => {
		const { sara, omar, group, milk } = await setup();
		expoReplies((m) => (m.to === "ExponentPushToken[omar-1]"
			? { status: "error", details: { error: "DeviceNotRegistered" } }
			: { status: "ok", id: "ticket" }));

		await removeItem(group, milk, sara);
		await waitFor(() => fetchMock.mock.calls.length > 0);
		await settle();

		const omarNow = await User.findById(omar._id).lean();
		expect(omarNow.pushTokens).toEqual(["ExponentPushToken[omar-2]"]);
	});

	test("the item is still removed when the push service is down", async () => {
		const { sara, group, milk } = await setup();
		fetchMock.mockRejectedValue(new Error("network down"));
		jest.spyOn(console, "error").mockImplementation(() => {});

		const res = await removeItem(group, milk, sara);
		await settle();

		expect(res.status).toBe(200);
		expect(await Item.exists({ _id: milk._id })).toBeNull();
	});

});


describe("Item removed — AC-02 (tapping the notification opens the group)", () => {

	test("the notification carries the id and name of the group the item was removed from", async () => {
		const { sara, group, milk } = await setup();

		await removeItem(group, milk, sara);
		await waitFor(() => fetchMock.mock.calls.length > 0);

		for (const m of sentMessages()) {
			expect(m.data).toMatchObject({ groupId: String(group._id), groupName: "Family groceries" });
		}
	});

});


describe("Item modified — AC-01 (members are notified when quantity or unit changes)", () => {

	test("changing the quantity updates the item and notifies the other members with the item name", async () => {
		const { omar, group, milk } = await setup();

		const res = await updateItem(group, milk, omar, { quantity: 3 });

		expect(res.status).toBe(200);
		expect(res.body.item).toMatchObject({ name: "Milk", quantity: 3, unit: "L" });

		await waitFor(() => fetchMock.mock.calls.length > 0);

		const messages = sentMessages();
		expect(messages.map((m) => m.to).sort()).toEqual(["ExponentPushToken[ali]", "ExponentPushToken[sara]"]);

		for (const m of messages) {
			expect(m.body).toContain("Milk");
			expect(m.body).toContain("2 L");
			expect(m.body).toContain("3 L");
			expect(m.data).toMatchObject({ type: "item_modified", itemName: "Milk", quantity: 3, unit: "L" });
		}
	});

	test("changing the unit notifies the other members", async () => {
		const { sara, group, eggs } = await setup();

		const res = await updateItem(group, eggs, sara, { unit: "box" });

		expect(res.status).toBe(200);
		expect(res.body.item.unit).toBe("box");

		await waitFor(() => fetchMock.mock.calls.length > 0);

		for (const m of sentMessages()) {
			expect(m.body).toContain("Eggs");
			expect(m.data).toMatchObject({ type: "item_modified", itemName: "Eggs", unit: "box" });
		}
	});

	test("changing both quantity and unit sends a single notification per phone", async () => {
		const { sara, group, milk } = await setup();

		await updateItem(group, milk, sara, { quantity: 1, unit: "gallon" });
		await waitFor(() => fetchMock.mock.calls.length > 0);
		await settle();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sentMessages()).toHaveLength(3);
	});

	test("no notification when nothing actually changed", async () => {
		const { sara, group, milk } = await setup();

		const res = await updateItem(group, milk, sara, { quantity: 2, unit: "L" });
		await settle();

		expect(res.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("rejects an invalid quantity or unit without notifying anyone", async () => {
		const { sara, group, milk } = await setup();

		const bad = await Promise.all([
			updateItem(group, milk, sara, { quantity: 0 }),
			updateItem(group, milk, sara, { quantity: "two" }),
			updateItem(group, milk, sara, { unit: "  " }),
			updateItem(group, milk, sara, {}),
		]);
		await settle();

		expect(bad.map((r) => r.status)).toEqual([400, 400, 400, 400]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await Item.findById(milk._id).lean()).toMatchObject({ quantity: 2, unit: "L" });
	});

});


describe("Item modified — AC-02 (tapping the notification opens the group)", () => {

	test("the notification carries the id and name of the group the item belongs to", async () => {
		const { sara, group, milk } = await setup();

		await updateItem(group, milk, sara, { quantity: 5 });
		await waitFor(() => fetchMock.mock.calls.length > 0);

		for (const m of sentMessages()) {
			expect(m.data).toMatchObject({ groupId: String(group._id), groupName: "Family groceries", itemId: String(milk._id) });
		}
	});

});


describe("Access control", () => {

	test("a non-member cannot remove or modify items, and nobody is notified", async () => {
		const { noura, group, milk } = await setup();

		const del = await removeItem(group, milk, noura);
		const upd = await updateItem(group, milk, noura, { quantity: 9 });
		await settle();

		expect(del.status).toBe(403);
		expect(upd.status).toBe(403);
		expect(await Item.exists({ _id: milk._id })).not.toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("requires a login", async () => {
		const { group, milk } = await setup();

		const res = await request(app).delete(`/api/groups/${group._id}/items/${milk._id}`);

		expect(res.status).toBe(401);
	});

	test("an item from another group cannot be removed through this group", async () => {
		const { sara, group } = await setup();
		const other = await Group.create({ name: "Office", createdBy: sara._id, members: [{ user: sara._id, role: "creator" }] });
		const coffee = await Item.create({ group: other._id, name: "Coffee", addedBy: sara._id });

		const res = await removeItem(group, coffee, sara);

		expect(res.status).toBe(404);
		expect(await Item.exists({ _id: coffee._id })).not.toBeNull();
	});

	test("invalid ids return 400", async () => {
		const { sara, group } = await setup();

		const badGroup = await request(app).delete("/api/groups/nope/items/nope").set("Authorization", tokenFor(sara));
		const badItem = await request(app).delete(`/api/groups/${group._id}/items/nope`).set("Authorization", tokenFor(sara));

		expect(badGroup.status).toBe(400);
		expect(badItem.status).toBe(400);
	});

});


describe("List items", () => {

	test("members can list and add items", async () => {
		const { omar, group } = await setup();

		const added = await request(app)
			.post(`/api/groups/${group._id}/items`)
			.set("Authorization", tokenFor(omar))
			.send({ name: "  Bread ", quantity: 1, unit: "loaf" });

		expect(added.status).toBe(201);
		expect(added.body.item).toMatchObject({ name: "Bread", quantity: 1, unit: "loaf" });

		const list = await request(app).get(`/api/groups/${group._id}/items`).set("Authorization", tokenFor(omar));

		expect(list.status).toBe(200);
		expect(list.body.items.map((i) => i.name)).toEqual(["Milk", "Eggs", "Bread"]);
	});

});
