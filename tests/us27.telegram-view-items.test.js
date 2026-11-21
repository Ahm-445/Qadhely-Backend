// US 27: Telegram chatbot — view the items of a shopping list (Jest + Supertest)
// Run from src/:  npm test
// Telegram is mocked (nothing is sent to telegram.org) and MongoDB is in memory.
// The US 25 webhook router is mounted in a small app, so no real webhook is involved.

process.env.JWT_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "test-token-not-real";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

jest.mock("../src/services/telegramService", () => ({
	sendTelegramMessage: jest.fn(async () => ({ ok: true })),
	answerCallbackQuery: jest.fn(async () => {}),
}));

const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const telegram = require("../src/services/telegramService");
const webhook = require("../src/webhooks/telegramWebhook");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");
const { formatItemMessages, isItemsCommand, MAX_MESSAGE_CHARS, MAX_MESSAGES } = require("../src/services/telegramItems");

const { ITEM_STATUSES } = ListItem;

const EGGS = "tamimi-137805"; // Large White Eggs Plastic Packaging, Al Gharbia, 30 count, Tamimi
const CREAM = "tamimi-1267"; // Cooking Cream, Almarai, 1L, Tamimi


const app = express();
app.use(express.json());
app.use("/webhooks/telegram", webhook);

let mongo;

beforeAll(async () => {
	mongo = await MongoMemoryServer.create();
	await mongoose.connect(mongo.getUri());
	await User.init();
});

afterAll(async () => {
	await mongoose.disconnect();
	await mongo.stop();
});

beforeEach(async () => {
	jest.spyOn(console, "error").mockImplementation(() => {});

	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({})]);

	telegram.sendTelegramMessage.mockClear();
	telegram.sendTelegramMessage.mockImplementation(async () => ({ ok: true }));
	telegram.answerCallbackQuery.mockClear();
});

afterEach(() => jest.restoreAllMocks());


let phoneCounter = 0;
let chatCounter = 1000;

// a Qadhely user linked to a Telegram chat
async function makeUser(handleName, { linked = true } = {}) {
	phoneCounter += 1;

	return User.create({
		handleName,
		phoneNumber: `+96650${String(phoneCounter).padStart(7, "0")}`,
		...(linked ? { telegramChatId: String(++chatCounter) } : {}),
	});
}

// like US 25 does when a linked user has exactly one list, the creator's own group is selected,
// unless select is false (a user with several lists has to pick one)
async function makeGroup(name, creator, others = [], { select = true } = {}) {
	const group = await Group.create({
		name,
		createdBy: creator._id,
		members: [{ user: creator._id, role: "creator" }, ...others.map(([user, role]) => ({ user: user._id, role }))],
	});

	if (select && creator.telegramChatId) await choose(creator, group);

	return group;
}

// what US 25 saves when the user picks (or is given) a group
const choose = (user, group) => User.updateOne({ _id: user._id }, { $set: { selectedGroupId: group._id, telegramStep: "idle" } });

const addItem = (group, creator, fields = {}) =>
	ListItem.create({ group: group._id, catalogItemId: EGGS, quantity: 1, unit: "piece", addedBy: creator._id, ...fields });

const chatOf = (user) => Number(user.telegramChatId);

const privateMessage = (chatId, text, extra = {}) => ({
	message: { chat: { id: chatId, type: "private" }, from: { id: chatId }, text, ...extra },
});

const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

// like Telegram, which sends the secret registered with setWebhook on every update
const send = (body) => request(app).post("/webhooks/telegram").set(SECRET_HEADER, process.env.TELEGRAM_WEBHOOK_SECRET).send(body);
const sendWithoutSecret = (body) => request(app).post("/webhooks/telegram").send(body);
const sendText = (user, text) => send(privateMessage(chatOf(user), text));

const sentTexts = () => telegram.sendTelegramMessage.mock.calls.map((call) => call[1]);
const lastOptions = () => telegram.sendTelegramMessage.mock.calls.at(-1)[2];

const selectedOf = async (user) => (await User.findById(user._id)).selectedGroupId;

const pick = (user, group) => send({
	callback_query: { id: "cb1", from: { id: chatOf(user) }, message: { chat: { id: chatOf(user) } }, data: `group:${group._id}` },
});


describe("US 27 — the /items command", () => {

	test("recognises /items and /items@BotName, and nothing else", () => {
		for (const text of ["/items", " /items ", "/ITEMS", "/items@QadhelyBot"]) expect(isItemsCommand(text)).toBe(true);
		for (const text of ["items", "/items now", "/itemsx", "/start", "", undefined, null, 5]) expect(isItemsCommand(text)).toBe(false);
	});

	test("a linked creator with one list gets its items without choosing; the list is remembered", async () => {
		const creator = await makeUser("Sara");
		const group = await makeGroup("Family", creator);

		await addItem(group, creator, { quantity: 2, unit: "box" });

		const res = await sendText(creator, "/items");

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).toHaveBeenCalledTimes(1);
		expect(telegram.sendTelegramMessage.mock.calls[0][0]).toBe(chatOf(creator));
		expect(sentTexts()[0]).toContain("Family");
		expect(sentTexts()[0]).toContain("Large White Eggs Plastic Packaging");
		expect(String(await selectedOf(creator))).toBe(String(group._id));
	});

	test("/items@BotName works the same", async () => {
		const creator = await makeUser("Sara");
		const group = await makeGroup("Family", creator);

		await addItem(group, creator);
		await sendText(creator, "/items@QadhelyBot");

		expect(sentTexts()[0]).toContain("Family");
	});

	test("messages are sent as plain text (no parse_mode, no markup)", async () => {
		const creator = await makeUser("Sara");
		const group = await makeGroup("Family", creator);

		await addItem(group, creator);
		await sendText(creator, "/items");

		expect(lastOptions()).toBeUndefined();
	});

	test("the chat id used in the reply is the sender's own chat", async () => {
		const creator = await makeUser("Sara");
		const group = await makeGroup("Family", creator);

		await addItem(group, creator);
		await sendText(creator, "/items");

		for (const call of telegram.sendTelegramMessage.mock.calls) expect(call[0]).toBe(chatOf(creator));
	});
});


describe("US 27 — group selection and persistence", () => {

	test("with several lists, /items asks the user to choose and shows only their creator/admin lists", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me, [], { select: false });
		const b = await makeGroup("List B", other, [[me, "admin"]]);
		await makeGroup("Member only", other, [[me, "member"]]);
		await makeGroup("Not mine", other);

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(sentTexts()[0]).toMatch(/select a shopping list/i);

		const keyboard = lastOptions().reply_markup.inline_keyboard.flat();

		expect(keyboard.map((button) => button.text).sort()).toEqual(["List A", "List B"]);
		expect(keyboard.map((button) => button.callback_data).sort()).toEqual([`group:${a._id}`, `group:${b._id}`].sort());
		expect(await selectedOf(me)).toBeNull();
	});

	test("choosing a list saves it for the user", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me, [], { select: false });
		await makeGroup("List B", other, [[me, "admin"]]);

		await pick(me, a);

		expect(String(await selectedOf(me))).toBe(String(a._id));
		expect(sentTexts()[0]).toContain("Selected list: List A");
	});

	test("the saved list is used by later /items requests and survives other messages", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me, [], { select: false });
		const b = await makeGroup("List B", other, [[me, "admin"]]);

		await addItem(a, me, { catalogItemId: EGGS });
		await addItem(b, other, { catalogItemId: CREAM });

		await pick(me, b);
		telegram.sendTelegramMessage.mockClear();

		await sendText(me, "/items");

		expect(sentTexts()).toHaveLength(1);
		expect(sentTexts()[0]).toContain("List B");
		expect(sentTexts()[0]).toContain("Cooking Cream");
		expect(sentTexts()[0]).not.toContain("Eggs");

		expect(String(await selectedOf(me))).toBe(String(b._id));
	});

	test("choosing another list changes the saved one", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me, [], { select: false });
		const b = await makeGroup("List B", other, [[me, "admin"]]);

		await pick(me, a);
		await pick(me, b);

		expect(String(await selectedOf(me))).toBe(String(b._id));
	});

	test("the selection of one user never affects another", async () => {
		const me = await makeUser("Me");
		const you = await makeUser("You");

		const a = await makeGroup("List A", me, [[you, "admin"]]);

		await pick(me, a);

		expect(await selectedOf(you)).toBeNull();
	});

	test("a regular member cannot choose a list (and nothing is saved)", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const member = await makeUser("Member");
		const group = await makeGroup("Family", owner, [[member, "member"]]);

		await pick(member, group);

		expect(sentTexts()[0]).toMatch(/do not have permission/i);
		expect(await selectedOf(member)).toBeNull();
	});

	test("a user cannot choose a list they are not in", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const outsider = await makeUser("Outsider");
		const group = await makeGroup("Private", owner);

		await pick(outsider, group);

		expect(await selectedOf(outsider)).toBeNull();
	});

	test("an invalid or missing group id in the button saves nothing and does not crash", async () => {
		const me = await makeUser("Me");

		for (const data of ["group:not-an-id", "group:", `group:${new mongoose.Types.ObjectId()}`]) {
			const res = await send({ callback_query: { id: "cb", from: { id: chatOf(me) }, message: { chat: { id: chatOf(me) } }, data } });

			expect(res.status).toBe(200);
		}

		expect(await selectedOf(me)).toBeNull();
	});

	test("someone not linked cannot choose a list", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const group = await makeGroup("Family", owner);

		const res = await send({ callback_query: { id: "cb", from: { id: 4242 }, message: { chat: { id: 4242 } }, data: `group:${group._id}` } });

		expect(res.status).toBe(200);
		expect(sentTexts()[0]).toMatch(/connect your qadhely account/i);
		expect((await User.countDocuments({ selectedGroupId: { $ne: null } }))).toBe(0);
	});
});


describe("US 27 — authorization", () => {

	test("an unlinked Telegram user gets no list data, only the connect instruction", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const group = await makeGroup("Secret family list", owner);

		await addItem(group, owner);

		const res = await send(privateMessage(777777, "/items"));

		expect(res.status).toBe(200);
		expect(sentTexts()).toHaveLength(1);
		expect(sentTexts()[0]).toMatch(/\/start/);
		expect(sentTexts().join(" ")).not.toContain("Secret family list");
		expect(sentTexts().join(" ")).not.toContain("Eggs");
	});

	test("a regular member, with a stale selection of the list, gets nothing", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const member = await makeUser("Member");
		const group = await makeGroup("Family", owner, [[member, "member"]]);

		await addItem(group, owner);
		await User.updateOne({ _id: member._id }, { selectedGroupId: group._id });

		await sendText(member, "/items");

		expect(sentTexts().join(" ")).not.toContain("Eggs");
		expect(sentTexts().join(" ")).not.toContain("Family");
		expect(sentTexts().join(" ")).toMatch(/not an admin/i);
		expect(await selectedOf(member)).toBeNull();
	});

	test("a user who is not in the group, with a forged selection, gets nothing", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const outsider = await makeUser("Outsider");
		const group = await makeGroup("Family", owner);

		await addItem(group, owner);
		await User.updateOne({ _id: outsider._id }, { selectedGroupId: group._id });

		await sendText(outsider, "/items");

		expect(sentTexts().join(" ")).not.toContain("Family");
		expect(sentTexts().join(" ")).not.toContain("Eggs");
		expect(await selectedOf(outsider)).toBeNull();
	});

	test("an admin who is removed from the list loses access at the next /items", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const admin = await makeUser("Admin");
		const group = await makeGroup("Family", owner, [[admin, "admin"]]);

		await addItem(group, owner);
		await choose(admin, group);

		await sendText(admin, "/items");
		expect(sentTexts()[0]).toContain("Family");

		await Group.updateOne({ _id: group._id }, { $pull: { members: { user: admin._id } } });
		telegram.sendTelegramMessage.mockClear();

		await sendText(admin, "/items");

		expect(sentTexts()[0]).toMatch(/no longer manage/i);
		expect(sentTexts().join(" ")).not.toContain("Eggs");
		expect(await selectedOf(admin)).toBeNull();
	});

	test("an admin who is demoted to member loses access at the next /items", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const admin = await makeUser("Admin");
		const group = await makeGroup("Family", owner, [[admin, "admin"]]);

		await addItem(group, owner);
		await choose(admin, group);
		await sendText(admin, "/items");
		telegram.sendTelegramMessage.mockClear();

		await Group.updateOne({ _id: group._id, "members.user": admin._id }, { $set: { "members.$.role": "member" } });

		await sendText(admin, "/items");

		expect(sentTexts().join(" ")).not.toContain("Eggs");
		expect(sentTexts()[0]).toMatch(/no longer manage/i);
	});

	test("after losing access, the user is told, never shown the old list, and the other list is announced when it is selected", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const me = await makeUser("Me");

		const old = await makeGroup("Old list", owner, [[me, "admin"]]);
		const mine = await makeGroup("My list", me);

		await addItem(mine, me, { catalogItemId: CREAM });
		await pick(me, old);
		await Group.updateOne({ _id: old._id }, { $pull: { members: { user: me._id } } });
		telegram.sendTelegramMessage.mockClear();

		await sendText(me, "/items");

		expect(sentTexts()[0]).toMatch(/no longer manage/i);
		expect(sentTexts().join(" ")).not.toContain("Cooking Cream");
		// the user's only remaining list is offered through US 25's single-list message, which names it
		expect(sentTexts()[1]).toContain("Selected list: My list");
		expect(String(await selectedOf(me))).toBe(String(mine._id));
		expect(telegram.sendTelegramMessage).toHaveBeenCalledTimes(2);
	});

	test("a promoted member gains access", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const member = await makeUser("Member");
		const group = await makeGroup("Family", owner, [[member, "member"]]);

		await addItem(group, owner);
		await sendText(member, "/items");
		expect(sentTexts().join(" ")).not.toContain("Eggs");

		await Group.updateOne({ _id: group._id, "members.user": member._id }, { $set: { "members.$.role": "admin" } });
		telegram.sendTelegramMessage.mockClear();

		// now an admin of one list, but nothing is selected yet: US 25's picker selects it ...
		await sendText(member, "/items");
		expect(sentTexts().join(" ")).toContain("Selected list: Family");
		expect(String(await selectedOf(member))).toBe(String(group._id));
		telegram.sendTelegramMessage.mockClear();

		// ... and /items then shows it
		await sendText(member, "/items");

		expect(sentTexts()[0]).toContain("Eggs");
	});

	test("a deleted group is handled: nothing is shown and the selection is cleared", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Gone soon", me);

		await addItem(group, me);
		await sendText(me, "/items");
		telegram.sendTelegramMessage.mockClear();

		await Group.deleteOne({ _id: group._id });

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(sentTexts().join(" ")).not.toContain("Eggs");
		expect(await selectedOf(me)).toBeNull();
	});

	test("a user who manages no list is told so", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const member = await makeUser("Member");

		await makeGroup("Family", owner, [[member, "member"]]);
		await sendText(member, "/items");

		expect(sentTexts().join(" ")).toMatch(/not an admin/i);
	});

	test("items of another group are never included", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const mine = await makeGroup("Mine", me);
		const theirs = await makeGroup("Theirs", other);

		await addItem(mine, me, { catalogItemId: EGGS });
		await addItem(theirs, other, { catalogItemId: CREAM });

		await sendText(me, "/items");

		expect(sentTexts().join(" ")).toContain("Eggs");
		expect(sentTexts().join(" ")).not.toContain("Cooking Cream");
	});

	test("a forged Telegram id in the body cannot be used to read another user's list", async () => {
		// the list is found by the chat the message came from, never by an id sent in the message
		const victim = await makeUser("Victim");
		const group = await makeGroup("Victim list", victim);

		await addItem(group, victim);

		await send({
			message: {
				chat: { id: 555555, type: "private" },
				from: { id: 555555 },
				text: "/items",
				contact: { user_id: chatOf(victim) },
				group: String(group._id),
			},
		});

		expect(sentTexts().join(" ")).not.toContain("Victim list");
	});

	test("/items in a group chat is ignored", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me);

		await addItem(group, me);

		const res = await send({ message: { chat: { id: chatOf(me), type: "group" }, from: { id: chatOf(me) }, text: "/items" } });

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
	});
});


describe("US 27 — what each item shows", () => {

	async function listFor(setup) {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me);

		await setup(group, me);
		await sendText(me, "/items");

		return sentTexts().join("\n---\n");
	}

	test("a catalog item shows its name, brand, size, quantity, unit, store and status", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: CREAM, quantity: 3, unit: "box" }));

		expect(text).toContain("Cooking Cream Almarai 1L");
		expect(text).toContain("Qty: 3 box");
		expect(text).toContain("Store: Tamimi");
		expect(text).toContain("Status: Pending");
	});

	test("a decimal quantity by weight is shown as is", async () => {
		const text = await listFor((group, me) => addItem(group, me, { quantity: 1.5, unit: "kg" }));

		expect(text).toContain("Qty: 1.5 kg");
	});

	test("a custom item shows its own name and store", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: undefined, customName: "Grandma's special dates", customStore: "Farmers market", quantity: 2, unit: "kg" }));

		expect(text).toContain("Grandma's special dates");
		expect(text).toContain("Store: Farmers market");
		expect(text).toContain("Qty: 2 kg");
	});

	test("a custom item without a store has no store part", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: undefined, customName: "Fresh mint" }));

		expect(text).toContain("Fresh mint");
		expect(text).not.toContain("Store:");
	});

	test("a catalog id that is no longer in the catalog still lists the item", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: "gone-999" }));

		expect(text).toContain("gone-999");
		expect(text).toContain("Status: Pending");
	});

	test("an item saved before US 16 (no status) reads as pending", async () => {
		const text = await listFor(async (group, me) => {
			const item = await addItem(group, me);

			await ListItem.collection.updateOne({ _id: item._id }, { $unset: { status: "" } });
		});

		expect(text).toContain("Status: Pending");
	});

	test("found", async () => {
		const text = await listFor((group, me) => addItem(group, me, { status: ITEM_STATUSES.FOUND }));

		expect(text).toContain("Status: Found");
		expect(text).toContain("✅");
	});

	test("not found, without a suggestion", async () => {
		const text = await listFor((group, me) => addItem(group, me, { status: ITEM_STATUSES.NOT_FOUND }));

		expect(text).toContain("Status: Not found");
		expect(text).not.toContain("Suggested replacement");
	});

	test("not found, with a suggested replacement", async () => {
		const text = await listFor((group, me) => addItem(group, me, { status: ITEM_STATUSES.NOT_FOUND, replacementText: "Brown eggs, any brand" }));

		expect(text).toContain("Status: Not found");
		expect(text).toContain("Suggested replacement: Brown eggs, any brand");
	});

	test("pending and found ignore a leftover replacement text", async () => {
		const text = await listFor(async (group, me) => {
			await addItem(group, me, { status: ITEM_STATUSES.PENDING, replacementText: "should not show" });
			await addItem(group, me, { status: ITEM_STATUSES.FOUND, replacementText: "nor this" });
		});

		expect(text).not.toContain("Suggested replacement");
	});

	test("replaced: shows the item that replaced it, and the replacement points back", async () => {
		const text = await listFor(async (group, me) => {
			const replacementId = new mongoose.Types.ObjectId();

			await addItem(group, me, { catalogItemId: EGGS, status: ITEM_STATUSES.REPLACED, replacedBy: replacementId });
			await addItem(group, me, { _id: replacementId, catalogItemId: CREAM, replacementFor: (await ListItem.findOne({ replacedBy: replacementId }))._id });
		});

		expect(text).toContain("Status: Replaced");
		expect(text).toContain("Replaced by: Cooking Cream Almarai 1L");
		expect(text).toContain("Replacement for: Large White Eggs Plastic Packaging");
	});

	test("replaced with a missing replacement falls back to the suggestion text", async () => {
		const text = await listFor((group, me) => addItem(group, me, { status: ITEM_STATUSES.REPLACED, replacedBy: new mongoose.Types.ObjectId(), replacementText: "Use the large pack" }));

		expect(text).toContain("Status: Replaced");
		expect(text).toContain("Suggested replacement: Use the large pack");
	});

	test("replaced items come last, newest first otherwise (as in the app)", async () => {
		const text = await listFor(async (group, me) => {
			const base = Date.now();

			await addItem(group, me, { customName: "oldest", catalogItemId: undefined, createdAt: new Date(base - 3000) });
			await addItem(group, me, { customName: "replaced one", catalogItemId: undefined, status: ITEM_STATUSES.REPLACED, createdAt: new Date(base) });
			await addItem(group, me, { customName: "newest", catalogItemId: undefined, createdAt: new Date(base - 1000) });
		});

		expect(text.indexOf("newest")).toBeLessThan(text.indexOf("oldest"));
		expect(text.indexOf("oldest")).toBeLessThan(text.indexOf("replaced one"));
	});

	test("the header counts items by status", async () => {
		const text = await listFor(async (group, me) => {
			await addItem(group, me, { status: ITEM_STATUSES.FOUND });
			await addItem(group, me, { status: ITEM_STATUSES.FOUND });
			await addItem(group, me, { status: ITEM_STATUSES.NOT_FOUND });
			await addItem(group, me, {});
		});

		expect(text).toContain("4 items: 1 pending, 2 found, 1 not found, 0 replaced");
	});

	test("one item reads \"1 item\"", async () => {
		const text = await listFor((group, me) => addItem(group, me));

		expect(text).toContain("1 item:");
		expect(text).not.toContain("1 items");
	});

	test("an empty list says so", async () => {
		const text = await listFor(() => {});

		expect(text).toContain("Family");
		expect(text).toMatch(/no items yet/i);
	});

	test("names with markup characters are plain text and never interpreted", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: undefined, customName: "<b>*bold*</b> [x](http://evil) _y_ `z`" }));

		expect(text).toContain("<b>*bold*</b> [x](http://evil) _y_ `z`");
		expect(lastOptions()).toBeUndefined();
	});

	test("control characters and line breaks in names cannot break the layout", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: undefined, customName: "Milk\n\n9. FAKE ITEM\u0000\u0007" }));

		expect(text).not.toMatch(/[\u0000-\u0008]/);
		expect(text).toContain("Milk 9. FAKE ITEM");
		expect(text).not.toContain("\n9. FAKE ITEM");
	});

	test("an overlong name is shortened", async () => {
		const text = await listFor((group, me) => addItem(group, me, { catalogItemId: undefined, customName: "x".repeat(100) }));

		expect(text).toContain("x".repeat(100));

		expect(formatItemMessages("G", [{ _id: new mongoose.Types.ObjectId(), customName: "y".repeat(5000), quantity: 1, unit: "piece" }])[0].length).toBeLessThan(600);
	});

	test("a long group name is shortened", () => {
		const [message] = formatItemMessages("g".repeat(5000), []);

		expect(message.length).toBeLessThan(400);
	});
});


describe("US 27 — long lists and Telegram's message limit", () => {

	const manyItems = (count, extra = {}) =>
		Array.from({ length: count }, (_, i) => ({
			_id: new mongoose.Types.ObjectId(),
			customName: `Item number ${i + 1} ${"n".repeat(60)}`,
			customStore: "Store",
			quantity: 1,
			unit: "piece",
			status: "pending",
			createdAt: new Date(2026, 0, 1, 0, 0, count - i),
			...extra,
		}));

	test("a list that fits is one message", () => {
		expect(formatItemMessages("G", manyItems(5))).toHaveLength(1);
	});

	test("a long list is split into several messages, each within the limit, with every item once and in order", () => {
		const messages = formatItemMessages("G", manyItems(40));

		expect(messages.length).toBeGreaterThan(1);

		for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);

		const all = messages.join("\n");

		for (let i = 1; i <= 40; i++) expect(all).toContain(`\n${i}. `);

		expect(all.indexOf("\n1. ")).toBeLessThan(all.indexOf("\n40. "));
		expect(all).not.toMatch(/not shown/);
	});

	test("the limit stays below Telegram's 4096 characters", () => {
		expect(MAX_MESSAGE_CHARS).toBeLessThan(4096);
	});

	test("an enormous list is cut after a few messages, with a note of how many were left out", () => {
		const messages = formatItemMessages("G", manyItems(2000));

		expect(messages).toHaveLength(MAX_MESSAGES);

		for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);

		expect(messages.at(-1)).toMatch(/\.\.\.and \d+ more items not shown/);

	});

	test("the cut-off note counts the hidden items exactly", () => {
		const messages = formatItemMessages("G", manyItems(2000));
		const text = messages.join("\n");

		const visible = messages.reduce((total, message) => total + (message.match(/(^|\n\n)\d+\. /g) || []).length, 0);
		const hidden = Number(/and (\d+) more items/.exec(text)[1]);

		expect(visible + hidden).toBe(2000);
	});

	test("items with the largest possible fields still fit the limit", () => {
		const big = Array.from({ length: 60 }, () => ({
			_id: new mongoose.Types.ObjectId(),
			customName: "N".repeat(1000),
			customStore: "S".repeat(1000),
			replacementText: "R".repeat(1000),
			status: "notFound",
			quantity: 99999999,
			unit: "piece",
		}));

		for (const message of formatItemMessages("G".repeat(1000), big)) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
	});

	test("end to end: a long saved list is sent as several messages, in order", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Big list", me);

		await ListItem.insertMany(manyItems(80).map(({ _id, createdAt, ...item }) => ({ ...item, group: group._id, addedBy: me._id })));

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage.mock.calls.length).toBeGreaterThan(1);

		for (const text of sentTexts()) expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
	});
});


describe("US 27 — Telegram failures", () => {

	test("when Telegram rejects the message the webhook still answers 200 and nothing is thrown", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me);

		await addItem(group, me);

		telegram.sendTelegramMessage.mockRejectedValue(new Error("Request failed with status code 502"));

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(console.error).toHaveBeenCalled();
	});

	test("when Telegram fails part way through a long list, sending stops and the answer is still 200", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Big list", me);

		await ListItem.insertMany(Array.from({ length: 80 }, (_, i) => ({ group: group._id, addedBy: me._id, customName: `Item ${i} ${"n".repeat(60)}`, quantity: 1, unit: "piece" })));

		telegram.sendTelegramMessage
			.mockResolvedValueOnce({ ok: true })
			.mockRejectedValue(new Error("Too Many Requests: retry after 5"));

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).toHaveBeenCalledTimes(2);
	});

	test("a Telegram failure does not lose the saved selection", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me);
		await makeGroup("List B", other, [[me, "admin"]]);

		telegram.sendTelegramMessage.mockRejectedValue(new Error("network down"));

		const res = await pick(me, a);

		expect(res.status).toBe(200);
		expect(String(await selectedOf(me))).toBe(String(a._id));
	});

	test("a database failure is answered 200 without sending any list data", async () => {
		const me = await makeUser("Me");

		jest.spyOn(User, "findOne").mockRejectedValueOnce(new Error("db down"));

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
	});

	test("a failure loading the items sends nothing", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me);

		await addItem(group, me);

		jest.spyOn(ListItem, "find").mockImplementationOnce(() => ({ lean: async () => { throw new Error("db down"); } }));

		const res = await sendText(me, "/items");

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
	});
});


describe("US 27 — US 25 behaviour is unchanged", () => {

	test("/start still asks to share the phone number", async () => {
		await send(privateMessage(31337, "/start"));

		expect(sentTexts()[0]).toMatch(/share your phone number/i);
		expect(lastOptions().reply_markup.keyboard[0][0].request_contact).toBe(true);
	});

	test("other text from a linked user still shows the group picker", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		await makeGroup("List A", me, [], { select: false });
		await makeGroup("List B", other, [[me, "admin"]]);

		await sendText(me, "hello");

		expect(sentTexts()[0]).toMatch(/more than one shopping list/i);
	});

	test("other text from an unlinked user still asks to send /start", async () => {
		await send(privateMessage(8080, "hello"));

		expect(sentTexts()[0]).toMatch(/\/start/);
	});

	test("a user with exactly one list who sends any text has it selected (US 25)", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Only list", me, [], { select: false });

		await sendText(me, "hello");

		expect(sentTexts()[0]).toContain("Selected list: Only list");
		expect(String(await selectedOf(me))).toBe(String(group._id));
	});

	test("the user model keeps its existing fields and the new one defaults to none", async () => {
		const me = await makeUser("Me", { linked: false });

		expect(me.selectedGroupId).toBeNull();
		expect(me.telegramChatId).toBeUndefined();
	});
});


describe("US 27 — /group reopens the authorized group picker", () => {

	const stepOf = async (user) => (await User.findById(user._id)).telegramStep;

	test("recognises /group and /group@BotName, and nothing else", () => {
		const { isGroupCommand } = require("../src/services/telegramItems");

		for (const text of ["/group", " /group ", "/GROUP", "/group@QadhelyBot"]) expect(isGroupCommand(text)).toBe(true);
		for (const text of ["group", "/groups", "/group now", "/items", "", undefined, null, 5]) expect(isGroupCommand(text)).toBe(false);
	});

	test("a user with several lists gets the picker with only the lists they are creator or admin of", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me, [], { select: false });
		const b = await makeGroup("List B", other, [[me, "admin"]]);
		await makeGroup("Member only", other, [[me, "member"]]);
		await makeGroup("Not mine", other);

		const res = await sendText(me, "/group");

		expect(res.status).toBe(200);

		const keyboard = lastOptions().reply_markup.inline_keyboard.flat();

		expect(keyboard.map((button) => button.text).sort()).toEqual(["List A", "List B"]);
		expect(keyboard.map((button) => button.callback_data).sort()).toEqual([`group:${a._id}`, `group:${b._id}`].sort());
		expect(sentTexts().join(" ")).not.toContain("Member only");
		expect(sentTexts().join(" ")).not.toContain("Not mine");
		expect(await stepOf(me)).toBe("select_group");
	});

	test("it works after a group was already selected (plain text can no longer reopen the picker)", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me);
		await makeGroup("List B", other, [[me, "admin"]]);

		expect(String(await selectedOf(me))).toBe(String(a._id));

		await sendText(me, "hello");
		expect(sentTexts()[0]).toMatch(/selected shopping list is saved/i);
		telegram.sendTelegramMessage.mockClear();

		await sendText(me, "/group");

		expect(sentTexts()[0]).toMatch(/more than one shopping list/i);
		expect(lastOptions().reply_markup.inline_keyboard).toHaveLength(2);
	});

	test("/group@BotName works the same", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		await makeGroup("List A", me, [], { select: false });
		await makeGroup("List B", other, [[me, "admin"]]);
		await sendText(me, "/group@QadhelyBot");

		expect(sentTexts()[0]).toMatch(/more than one shopping list/i);
	});

	test("picking from the reopened picker changes the list that /items shows", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me);
		const b = await makeGroup("List B", other, [[me, "admin"]]);

		await addItem(a, me, { catalogItemId: EGGS });
		await addItem(b, other, { catalogItemId: CREAM });

		await sendText(me, "/items");
		expect(sentTexts()[0]).toContain("Eggs");

		await sendText(me, "/group");
		await pick(me, b);
		telegram.sendTelegramMessage.mockClear();

		await sendText(me, "/items");

		expect(sentTexts()[0]).toContain("List B");
		expect(sentTexts()[0]).toContain("Cooking Cream");
		expect(sentTexts()[0]).not.toContain("Eggs");
		expect(await stepOf(me)).toBe("idle");
	});

	test("while the picker is open, /items asks to choose and shows no list", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		const a = await makeGroup("List A", me);
		await makeGroup("List B", other, [[me, "admin"]]);
		await addItem(a, me);

		await sendText(me, "/group");
		telegram.sendTelegramMessage.mockClear();

		await sendText(me, "/items");

		expect(sentTexts()[0]).toMatch(/select a shopping list first/i);
		expect(sentTexts().join(" ")).not.toContain("Eggs");
	});

	test("with exactly one list it is selected and named", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Only list", me, [], { select: false });

		await sendText(me, "/group");

		expect(sentTexts()[0]).toContain("Selected list: Only list");
		expect(String(await selectedOf(me))).toBe(String(group._id));
	});

	test("a user who manages no list is told so, and their old selection is cleared", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const member = await makeUser("Member");
		const group = await makeGroup("Family", owner, [[member, "member"]]);

		await choose(member, group);
		await sendText(member, "/group");

		expect(sentTexts()[0]).toMatch(/not an admin/i);
		expect(sentTexts().join(" ")).not.toContain("Family");
		expect(await selectedOf(member)).toBeNull();
	});

	test("an admin who was removed gets no picker entry for that list", async () => {
		const owner = await makeUser("Owner", { linked: false });
		const me = await makeUser("Me");
		const group = await makeGroup("Old list", owner, [[me, "admin"]]);

		await Group.updateOne({ _id: group._id }, { $pull: { members: { user: me._id } } });
		await sendText(me, "/group");

		expect(sentTexts().join(" ")).not.toContain("Old list");
		expect(sentTexts()[0]).toMatch(/not an admin/i);
	});

	test("an unlinked Telegram user gets only the connect instruction, no group names", async () => {
		const owner = await makeUser("Owner", { linked: false });

		await makeGroup("Secret family list", owner);

		const res = await send(privateMessage(777777, "/group"));

		expect(res.status).toBe(200);
		expect(sentTexts()).toHaveLength(1);
		expect(sentTexts()[0]).toMatch(/\/start/);
		expect(sentTexts().join(" ")).not.toContain("Secret family list");
		expect(lastOptions()).toBeUndefined();
	});

	test("a Qadhely user who never linked Telegram cannot be reached through someone else's chat", async () => {
		const unlinked = await makeUser("Unlinked", { linked: false });

		await makeGroup("Their list", unlinked, [], { select: false });

		await send(privateMessage(424242, "/group"));

		expect(sentTexts().join(" ")).not.toContain("Their list");
	});

	test("it only changes the sender's own state", async () => {
		const me = await makeUser("Me");
		const you = await makeUser("You");
		const other = await makeUser("Other", { linked: false });

		await makeGroup("List A", me);
		await makeGroup("List B", other, [[me, "admin"]]);
		const yours = await makeGroup("Yours", you);

		await sendText(me, "/group");

		expect(String(await selectedOf(you))).toBe(String(yours._id));
		expect(await stepOf(you)).toBe("idle");
	});

	test("/group in a group chat is ignored", async () => {
		const me = await makeUser("Me");

		await makeGroup("List A", me);

		const res = await send({ message: { chat: { id: chatOf(me), type: "group" }, from: { id: chatOf(me) }, text: "/group" } });

		expect(res.status).toBe(200);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
	});

	test("a Telegram failure while sending the picker answers 200 and keeps the saved state", async () => {
		const me = await makeUser("Me");
		const other = await makeUser("Other", { linked: false });

		await makeGroup("List A", me);
		await makeGroup("List B", other, [[me, "admin"]]);

		telegram.sendTelegramMessage.mockRejectedValue(new Error("network down"));

		const res = await sendText(me, "/group");

		expect(res.status).toBe(200);
		expect(await stepOf(me)).toBe("select_group");
	});
});


describe("US 27 — the webhook secret still protects the new commands (US 25)", () => {

	async function setup() {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me);

		await addItem(group, me);

		return me;
	}

	test.each(["/items", "/group"])("%s without the secret is refused: 401, nothing sent, no state changed", async (command) => {
		const me = await setup();
		const before = await User.findById(me._id).lean();

		const res = await sendWithoutSecret(privateMessage(chatOf(me), command));

		expect(res.status).toBe(401);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
		expect(await User.findById(me._id).lean()).toEqual(before);
	});

	test.each(["/items", "/group"])("%s with a wrong secret is refused", async (command) => {
		const me = await setup();

		const res = await request(app).post("/webhooks/telegram").set(SECRET_HEADER, "wrong").send(privateMessage(chatOf(me), command));

		expect(res.status).toBe(401);
		expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
	});

	test("when the server has no secret configured, every request is refused, even with a header", async () => {
		const me = await setup();
		const saved = process.env.TELEGRAM_WEBHOOK_SECRET;

		try {
			delete process.env.TELEGRAM_WEBHOOK_SECRET;

			for (const header of [undefined, "", "undefined"]) {
				const req = request(app).post("/webhooks/telegram");

				if (header !== undefined) req.set(SECRET_HEADER, header);

				expect((await req.send(privateMessage(chatOf(me), "/items"))).status).toBe(401);
			}

			expect(telegram.sendTelegramMessage).not.toHaveBeenCalled();
		}
		finally {
			process.env.TELEGRAM_WEBHOOK_SECRET = saved;
		}
	});

	test("a callback (group pick) without the secret changes nothing", async () => {
		const me = await makeUser("Me");
		const group = await makeGroup("Family", me, [], { select: false });

		const res = await request(app).post("/webhooks/telegram").send({
			callback_query: { id: "c", from: { id: chatOf(me) }, message: { chat: { id: chatOf(me) } }, data: `group:${group._id}` },
		});

		expect(res.status).toBe(401);
		expect(await selectedOf(me)).toBeNull();
	});
});
