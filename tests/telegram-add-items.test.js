// Telegram Chatbot Add Items to List — API tests (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.
// Telegram itself is not called: the messages the bot would send are collected instead.
// The push service is not called either: the US 18 notification is only checked to be started.

process.env.JWT_SECRET = "test-secret";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

jest.mock("../src/services/telegramService", () => ({
	sendTelegramMessage: jest.fn(async () => ({ ok: true })),
	answerCallbackQuery: jest.fn(async () => {}),
}));

jest.mock("../src/services/pushNotifications", () => ({
	...jest.requireActual("../src/services/pushNotifications"),
	notifyItemsAdded: jest.fn(async () => ({ eligible: false })),
}));

const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const telegramWebhook = require("../src/webhooks/telegramWebhook");
const { sendTelegramMessage } = require("../src/services/telegramService");
const { notifyItemsAdded } = require("../src/services/pushNotifications");
const { parseAddCommand } = require("../src/webhooks/telegramListCommands");
const { searchCatalog } = require("../src/services/catalog");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");
const ItemHistory = require("../src/models/ItemHistory");


// small app with only the Telegram webhook (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/webhooks/telegram", telegramWebhook);


let mongo;

const CHAT_ID = 5550002;


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_telegram_add_items" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({}), ItemHistory.deleteMany({})]);
	sendTelegramMessage.mockClear();
	notifyItemsAdded.mockClear();
});


// an admin connected to Telegram with a selected group that already holds one item
async function setup({ role = "admin" } = {}) {
	const [admin, owner] = await User.insertMany([
		{ handleName: "Sara", phoneNumber: "+966550000001", telegramChatId: String(CHAT_ID) },
		{ handleName: "Omar", phoneNumber: "+966550000002" },
	]);
	const group = await Group.create({
		name: "Family groceries",
		createdBy: owner._id,
		members: [
			{ user: owner._id, role: "creator" },
			{ user: admin._id, role },
		],
	});
	admin.selectedGroupId = group._id;
	await admin.save();

	const bread = await ListItem.create({ group: group._id, addedBy: owner._id, customName: "Homemade bread", quantity: 3, unit: "piece" });

	return { admin, owner, group, bread };
}

// the admin types a message in the private chat with the bot
const send = (text) => request(app)
	.post("/webhooks/telegram")
	.set("X-Telegram-Bot-Api-Secret-Token", process.env.TELEGRAM_WEBHOOK_SECRET)
	.send({ message: { chat: { id: CHAT_ID, type: "private" }, from: { id: CHAT_ID }, text } });

// the text of the last message the bot sent
const lastReply = () => sendTelegramMessage.mock.calls.at(-1)?.[1] ?? "";

const userState = async () => User.findOne({ telegramChatId: String(CHAT_ID) }).lean();

const MILK = searchCatalog("milk", { limit: 20 }).items;



describe("AC-01 — searching sends the top 20 catalog results", () => {

	test("/add asks for an item name", async () => {
		await setup();

		const res = await send("/add");

		expect(res.status).toBe(200);
		expect(lastReply()).toContain("Send the name of the item you want to add");
		expect(lastReply()).toContain("/cancel");
		expect(await userState()).toMatchObject({ telegramStep: "enter_search", telegramAction: "add" });
	});

	test("a search sends at most 20 numbered results, best first", async () => {
		await setup();

		await send("/add");
		await send("milk");

		const reply = lastReply();
		expect(searchCatalog("milk").total).toBeGreaterThan(20);
		expect(reply).toContain(`Top 20 of ${searchCatalog("milk").total} results for "milk"`);
		expect(reply).toContain(`1. ${MILK[0].name_en}`);
		expect(reply).toContain(`20. ${MILK[19].name_en}`);
		expect(reply).not.toMatch(/^21\. /m);
		expect(reply).toContain("Send the number of the item to add");

		const state = await userState();
		expect(state.telegramStep).toBe("select_result");
		expect(state.telegramSearchResults).toEqual(MILK.map((product) => product.id));
	});

	test("/add with words searches straight away", async () => {
		await setup();

		await send("/add tortilla");

		expect(lastReply()).toContain('Results for "tortilla"');
		expect(lastReply()).toContain("Original Tortilla 6 Wraps");
		expect((await userState()).telegramStep).toBe("select_result");
	});

	test("a search with no results says so and asks again", async () => {
		await setup();

		await send("/add");
		await send("zzzz");

		expect(lastReply()).toContain('No items were found for "zzzz"');
		expect((await userState()).telegramStep).toBe("enter_search");
	});

	test("another name instead of a number searches again", async () => {
		await setup();

		await send("/add milk");
		await send("eggs");

		expect(lastReply()).toContain('Results for "eggs"');
		expect((await userState()).telegramSearchResults).toEqual(searchCatalog("eggs", { limit: 20 }).items.map((p) => p.id));
	});

});


describe("AC-02 — selecting a result asks for the quantity and unit", () => {

	test("a result number asks for the quantity and one of kg, piece or box", async () => {
		await setup();

		await send("/add milk");
		await send("2");

		expect(lastReply()).toContain(`How much ${MILK[1].name_en} do you need?`);
		expect(lastReply()).toContain("kg, piece or box");
		expect(await userState()).toMatchObject({ telegramStep: "enter_quantity", telegramAction: "add", telegramCatalogItemId: MILK[1].id });
	});

	test("Arabic digits pick a result too", async () => {
		await setup();

		await send("/add milk");
		await send("٣");

		expect((await userState()).telegramCatalogItemId).toBe(MILK[2].id);
	});

});


describe("AC-03 — submitting adds the item and sends the updated list", () => {

	test("the item is added to the group's list and the updated list is sent", async () => {
		const { admin, group } = await setup();

		await send("/add milk");
		await send("1");
		await send("2 piece");

		const added = await ListItem.findOne({ group: group._id, catalogItemId: MILK[0].id }).lean();
		expect(added).toMatchObject({ quantity: 2, unit: "piece", status: "pending" });
		expect(String(added.addedBy)).toBe(String(admin._id));
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);

		const reply = lastReply();
		expect(reply).toContain(`Added ${MILK[0].name_en} — 2 piece.`);
		expect(reply).toContain("Your shopping list:");
		expect(reply).toContain(`1. ${MILK[0].name_en} — 2 piece (Tamimi)`);
		expect(reply).toContain("2. Homemade bread — 3 piece");

		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null, telegramCatalogItemId: null, telegramSearchResults: [] });
	});

	test("a decimal quantity by kg is accepted", async () => {
		const { group } = await setup();

		await send("/add milk");
		await send("1");
		await send("1.5 kg");

		expect(await ListItem.findOne({ group: group._id, catalogItemId: MILK[0].id }).lean()).toMatchObject({ quantity: 1.5, unit: "kg" });
	});

	test("the addition is recorded like one from the app: item history and the US 18 notification", async () => {
		const { admin, group } = await setup();

		await send("/add milk");
		await send("1");
		await send("1 box");

		expect(await ItemHistory.countDocuments({ group: group._id, catalogItemId: MILK[0].id })).toBe(1);
		expect(notifyItemsAdded).toHaveBeenCalledTimes(1);
		expect(String(notifyItemsAdded.mock.calls[0][0])).toBe(String(group._id));
		expect(String(notifyItemsAdded.mock.calls[0][1])).toBe(String(admin._id));
	});

});


describe("AC-04 — cancelling changes nothing", () => {

	test.each([
		["while asked for a name", ["/add"]],
		["while the results are shown", ["/add milk"]],
		["while asked for the quantity", ["/add milk", "1"]],
	])("/cancel %s", async (_, steps) => {
		const { group } = await setup();

		for (const step of steps) await send(step);
		await send("/cancel");

		expect(lastReply()).toBe("Cancelled. Your shopping list was not changed.");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null, telegramCatalogItemId: null, telegramSearchResults: [] });
		expect(notifyItemsAdded).not.toHaveBeenCalled();

		// a number sent afterwards is not taken as a choice
		await send("1 piece");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

});


describe("AC-05 — an invalid value is reported and the step is asked again", () => {

	test.each(["0", "21", "٢١"])("result number %p is refused", async (text) => {
		await setup();

		await send("/add milk");
		await send(text);

		expect(lastReply()).toContain("That input is incorrect.");
		expect(lastReply()).toContain("/cancel");
		expect(await userState()).toMatchObject({ telegramStep: "select_result", telegramCatalogItemId: null });
	});

	test("a number out of range keeps the results so the admin can pick again", async () => {
		await setup();

		await send("/add milk");
		await send("21");

		expect(lastReply()).toContain("That input is incorrect. Send a number from 1 to 20");

		await send("1");
		expect((await userState()).telegramCatalogItemId).toBe(MILK[0].id);
	});

	test.each([
		["no unit", "2"],
		["an unknown unit", "2 litre"],
		["words", "two piece"],
		["a decimal that is not kg", "1.5 piece"],
	])("a quantity with %s is refused and asked again", async (_, text) => {
		const { group } = await setup();

		await send("/add milk");
		await send("1");
		await send(text);

		expect(lastReply()).toContain("That input is incorrect.");
		expect(lastReply()).toContain("/cancel");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
		expect((await userState()).telegramStep).toBe("enter_quantity");

		// the step can be redone
		await send("2 box");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(2);
	});

	test("a command-like or too long search is refused", async () => {
		await setup();

		await send("/add");
		await send("/whatever");
		expect(lastReply()).toContain("That input is incorrect. Send the name of an item");

		await send("x".repeat(101));
		expect(lastReply()).toContain("That input is incorrect. Send the name of an item");
		expect((await userState()).telegramStep).toBe("enter_search");
	});

});


describe("who can add items", () => {

	test("a regular member is refused and nothing changes", async () => {
		const { group } = await setup({ role: "member" });

		await send("/add milk");

		expect(lastReply()).toBe("You do not have permission to manage this group.");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

	test("an admin who lost the role before submitting cannot add", async () => {
		const { admin, group } = await setup();

		await send("/add milk");
		await send("1");
		await Group.updateOne({ _id: group._id, "members.user": admin._id }, { $set: { "members.$.role": "member" } });
		await send("2 piece");

		expect(lastReply()).toBe("You do not have permission to manage this group.");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
		expect(notifyItemsAdded).not.toHaveBeenCalled();
	});

	test("the help message mentions /add", async () => {
		await setup();

		await send("hello");

		expect(lastReply()).toContain("/add to add an item");
	});

});


describe("parseAddCommand", () => {

	test.each([
		["/add", ""],
		["/ADD", ""],
		["/add@QadhelyBot", ""],
		["/add milk", "milk"],
		["/add   fresh milk  ", "fresh milk"],
		["/add@QadhelyBot eggs", "eggs"],
	])("%p", (text, expected) => {
		expect(parseAddCommand(text)).toBe(expected);
	});

	test.each(["add milk", "/added", "/address", "milk"])("not a command: %p", (text) => {
		expect(parseAddCommand(text)).toBeNull();
	});

});
