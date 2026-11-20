// US 28: Telegram Chatbot Remove Items in List, US 29: Telegram Chatbot Modify Items in List
// API tests (Jest + Supertest). Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.
// Telegram itself is not called: the messages the bot would send are collected instead.

process.env.JWT_SECRET = "test-secret";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

jest.mock("../src/services/telegramService", () => ({
	sendTelegramMessage: jest.fn(async () => ({ ok: true })),
	answerCallbackQuery: jest.fn(async () => {}),
}));

const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const telegramWebhook = require("../src/webhooks/telegramWebhook");
const { sendTelegramMessage } = require("../src/services/telegramService");
const { parseQuantityAndUnit } = require("../src/webhooks/telegramListCommands");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");


// small app with only the Telegram webhook (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/webhooks/telegram", telegramWebhook);


let mongo;

const CHAT_ID = 5550001;


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us28_us29" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);
	sendTelegramMessage.mockClear();
});


// an admin connected to Telegram with a selected group holding three items, oldest first:
// eggs, then tortilla, then bread (a custom request); the list shows newest first
async function setup({ role = "creator" } = {}) {
	const [admin, owner] = await User.insertMany([
		{ handleName: "Sara", phoneNumber: "+966550000001", telegramChatId: String(CHAT_ID) },
		{ handleName: "Omar", phoneNumber: "+966550000002" },
	]);
	const group = await Group.create({
		name: "Family groceries",
		createdBy: owner._id,
		members: [
			{ user: owner._id, role: "creator" },
			{ user: admin._id, role: role === "creator" ? "admin" : role },
		],
	});
	admin.selectedGroupId = group._id;
	await admin.save();

	const base = { group: group._id, addedBy: owner._id };
	const eggs = await ListItem.create({ ...base, catalogItemId: "tamimi-137805", quantity: 2, unit: "box", createdAt: new Date(Date.now() - 3000) });
	const tortilla = await ListItem.create({ ...base, catalogItemId: "tamimi-195830", quantity: 1, unit: "piece", createdAt: new Date(Date.now() - 2000) });
	const bread = await ListItem.create({ ...base, customName: "Homemade bread", quantity: 3, unit: "piece", createdAt: new Date(Date.now() - 1000) });

	return { admin, group, eggs, tortilla, bread };
}

// the admin types a message in the private chat with the bot
const send = (text) => request(app)
	.post("/webhooks/telegram")
	.set("X-Telegram-Bot-Api-Secret-Token", process.env.TELEGRAM_WEBHOOK_SECRET)
	.send({ message: { chat: { id: CHAT_ID, type: "private" }, from: { id: CHAT_ID }, text } });

// the text of the last message the bot sent
const lastReply = () => sendTelegramMessage.mock.calls.at(-1)?.[1] ?? "";

const userState = async () => User.findOne({ telegramChatId: String(CHAT_ID) }).lean();



describe("US 28 — remove an item from Telegram", () => {

	test("AC-01: /remove sends the numbered list, newest first, and asks for an item", async () => {
		await setup();

		const res = await send("/remove");

		expect(res.status).toBe(200);
		expect(lastReply()).toContain("1. Homemade bread — 3 piece");
		expect(lastReply()).toContain("2. Original Tortilla 6 Wraps — 1 piece (Tamimi)");
		expect(lastReply()).toContain("3. Large White Eggs Plastic Packaging — 2 box (Tamimi)");
		expect(lastReply()).toContain("Send the number of the item to remove.");
		expect(await userState()).toMatchObject({ telegramStep: "select_item", telegramAction: "remove" });
	});

	test("AC-02: picking a number removes that item and sends the updated list", async () => {
		const { tortilla, eggs, bread } = await setup();

		await send("/remove");
		await send("2");

		expect(await ListItem.findById(tortilla._id)).toBeNull();
		expect(await ListItem.countDocuments({ _id: { $in: [eggs._id, bread._id] } })).toBe(2);
		expect(lastReply()).toContain("Removed Original Tortilla 6 Wraps.");
		expect(lastReply()).toContain("1. Homemade bread");
		expect(lastReply()).toContain("2. Large White Eggs Plastic Packaging");
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null });
	});

	test("AC-02: removing the last item says the list is now empty", async () => {
		const { tortilla, eggs } = await setup();
		await ListItem.deleteMany({ _id: { $in: [tortilla._id, eggs._id] } });

		await send("/remove");
		await send("1");

		expect(await ListItem.countDocuments({})).toBe(0);
		expect(lastReply()).toContain("Your shopping list is now empty.");
	});

	test("AC-03: /cancel changes nothing", async () => {
		await setup();

		await send("/remove");
		await send("/cancel");

		expect(await ListItem.countDocuments({})).toBe(3);
		expect(lastReply()).toBe("Cancelled. Your shopping list was not changed.");
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null });
	});

	test.each(["9", "0", "two", "1.5"])("AC-04: %s is reported as incorrect and the step is asked again", async (input) => {
		await setup();

		await send("/remove");
		await send(input);

		expect(await ListItem.countDocuments({})).toBe(3);
		expect(lastReply()).toContain("That input is incorrect. Send a number from 1 to 3.");
		expect(await userState()).toMatchObject({ telegramStep: "select_item", telegramAction: "remove" });

		await send("1");
		expect(await ListItem.countDocuments({})).toBe(2);
	});

	test("Arabic digits pick an item too", async () => {
		const { bread } = await setup();

		await send("/remove");
		await send("١");

		expect(await ListItem.findById(bread._id)).toBeNull();
	});

	test("an empty list says so and starts nothing", async () => {
		await setup();
		await ListItem.deleteMany({});

		await send("/remove");

		expect(lastReply()).toBe("Your shopping list is empty.");
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null });
	});

});



describe("US 29 — modify an item from Telegram", () => {

	test("AC-01 and AC-02: /modify sends the list, and picking an item asks for the new quantity and unit", async () => {
		const { eggs } = await setup();

		await send("/modify");
		expect(lastReply()).toContain("Send the number of the item to modify.");

		await send("3");
		expect(lastReply()).toContain("Send the new quantity and unit for Large White Eggs Plastic Packaging");

		const state = await userState();
		expect(state).toMatchObject({ telegramStep: "enter_quantity", telegramAction: "modify" });
		expect(String(state.telegramItemId)).toBe(String(eggs._id));
	});

	test("AC-03: the new quantity and unit are saved and the updated list is sent", async () => {
		const { eggs } = await setup();

		await send("/modify");
		await send("3");
		await send("1.5 kg");

		expect(await ListItem.findById(eggs._id).lean()).toMatchObject({ quantity: 1.5, unit: "kg" });
		expect(lastReply()).toContain("Updated Large White Eggs Plastic Packaging to 1.5 kg.");
		expect(lastReply()).toContain("3. Large White Eggs Plastic Packaging — 1.5 kg (Tamimi)");
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null, telegramItemId: null });
	});

	test("AC-04: /cancel while asked for the quantity changes nothing", async () => {
		const { eggs } = await setup();

		await send("/modify");
		await send("3");
		await send("/cancel");

		expect(await ListItem.findById(eggs._id).lean()).toMatchObject({ quantity: 2, unit: "box" });
		expect(lastReply()).toBe("Cancelled. Your shopping list was not changed.");
	});

	test.each([
		["a decimal for a unit other than kg", "2.5 piece", "whole number unless the unit is kg"],
		["an unknown unit", "2 litre", "Send a number and a unit"],
		["no unit", "4", "Send a number and a unit"],
		["no number", "lots", "Send a number and a unit"],
	])("AC-05: %s is reported as incorrect and the step is asked again", async (_label, input, message) => {
		const { eggs } = await setup();

		await send("/modify");
		await send("3");
		await send(input);

		expect(lastReply()).toContain("That input is incorrect.");
		expect(lastReply()).toContain(message);
		expect(await ListItem.findById(eggs._id).lean()).toMatchObject({ quantity: 2, unit: "box" });
		expect(await userState()).toMatchObject({ telegramStep: "enter_quantity", telegramAction: "modify" });

		await send("4 boxes");
		expect(await ListItem.findById(eggs._id).lean()).toMatchObject({ quantity: 4, unit: "box" });
	});

	test("an item removed in the app meanwhile is reported, and nothing else changes", async () => {
		const { eggs } = await setup();

		await send("/modify");
		await send("3");
		await ListItem.deleteOne({ _id: eggs._id });
		await send("2 box");

		expect(lastReply()).toContain("That item is no longer on the list.");
		expect(await ListItem.countDocuments({})).toBe(2);
	});

});



describe("who can remove or modify", () => {

	test("a regular member is refused and nothing changes", async () => {
		await setup({ role: "member" });

		await send("/remove");

		expect(lastReply()).toBe("You do not have permission to manage this group.");
		expect(await userState()).toMatchObject({ telegramStep: "idle", telegramAction: null });
	});

	test("an admin who lost the role in the middle cannot finish", async () => {
		const { admin, group } = await setup();

		await send("/remove");
		await Group.updateOne({ _id: group._id, "members.user": admin._id }, { $set: { "members.$.role": "member" } });
		await send("1");

		expect(await ListItem.countDocuments({})).toBe(3);
		expect(lastReply()).toBe("You do not have permission to manage this group.");
	});

	test("other text keeps the help message", async () => {
		await setup();

		await send("hello");

		expect(lastReply()).toContain("Send /remove to remove an item or /modify");
	});

});



describe("parseQuantityAndUnit", () => {

	test.each([
		["2 piece", { quantity: 2, unit: "piece" }],
		["3 pieces", { quantity: 3, unit: "piece" }],
		["1.5 KG", { quantity: 1.5, unit: "kg" }],
		["1box", { quantity: 1, unit: "box" }],
		["٢٫٥ kg", { quantity: 2.5, unit: "kg" }],
	])("%s", (text, expected) => {
		expect(parseQuantityAndUnit(text)).toEqual(expected);
	});

	test.each(["", "kg", "2", "two kg", "-1 kg", "2 litre"])("rejects %p", (text) => {
		expect(parseQuantityAndUnit(text)).toBeNull();
	});

});
