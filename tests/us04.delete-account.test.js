// US 04: Delete Account — API tests (Jest + Supertest)
// POST /api/account/delete/send-otp sends a WhatsApp code to the logged-in user (AC-01);
// POST /api/account/delete/verify { otp, confirmed: true } deletes the account (AC-02 to AC-04).
// Authentica is mocked, so no real messages are sent.
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

jest.mock("../src/services/authentica");

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const accountRoutes = require("../src/routes/accountRoutes");
const { sendAuthOtp, verifyOtp } = require("../src/services/authentica");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");
const AccountDeletionOtp = require("../src/models/AccountDeletionOtp");
const OtpRequestLog = require("../src/models/OtpRequestLog");


// small app with only the account routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/account", accountRoutes);


let mongo;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

const sendOtp = (user) => request(app).post("/api/account/delete/send-otp").set("Authorization", tokenFor(user)).send();
const verify = (user, body) => request(app).post("/api/account/delete/verify").set("Authorization", tokenFor(user)).send(body);
const confirm = (user, otp = "123456") => verify(user, { otp, confirmed: true });

async function makeUser(name, n) {
	return User.create({ handleName: name, phoneNumber: `+96655${String(n).padStart(7, "0")}` });
}

// members join one day apart, in the order given (or at m.joinedAt when set)
async function makeGroup(name, members) {
	const start = Date.now() - 30 * 24 * 60 * 60 * 1000;
	return Group.create({
		name,
		createdBy: members.find((m) => m.role === "creator").user._id,
		members: members.map((m, i) => ({ user: m.user._id, role: m.role, joinedAt: m.joinedAt ?? new Date(start + i * 24 * 60 * 60 * 1000) })),
	});
}

const addItem = (group, user) => ListItem.create({ group: group._id, customName: "Milk", quantity: 1, unit: "piece", addedBy: user._id });


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us04" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({}), ListItem.deleteMany({}), AccountDeletionOtp.deleteMany({}), OtpRequestLog.deleteMany({})]);
	jest.clearAllMocks();
	sendAuthOtp.mockResolvedValue(true);
	verifyOtp.mockResolvedValue("valid");
});


describe("POST /api/account/delete/send-otp — AC-01", () => {

	test("sends a WhatsApp code to the logged-in user's own phone and answers with a 60-second expiry", async () => {
		const sara = await makeUser("Sara", 1);

		const res = await sendOtp(sara);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ sent: true, expiresInSeconds: 60 });
		expect(sendAuthOtp).toHaveBeenCalledWith(sara.phoneNumber);

		const pending = await AccountDeletionOtp.findOne({ user: sara._id });
		expect(pending.status).toBe("pending");
		expect(pending.expiresAt - pending.sentAt).toBe(60 * 1000);
	});

	test("nothing is deleted by asking for a code", async () => {
		const sara = await makeUser("Sara", 1);

		await sendOtp(sara);

		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("a request without a token gets 401 and no code is sent", async () => {
		const res = await request(app).post("/api/account/delete/send-otp").send();

		expect(res.status).toBe(401);
		expect(sendAuthOtp).not.toHaveBeenCalled();
	});

	test("a token for an account that no longer exists gets 404", async () => {
		const sara = await makeUser("Sara", 1);
		await User.deleteOne({ _id: sara._id });

		const res = await sendOtp(sara);

		expect(res.status).toBe(404);
		expect(sendAuthOtp).not.toHaveBeenCalled();
	});

	test("the 6th code in one hour gets 429", async () => {
		const sara = await makeUser("Sara", 1);

		for (let i = 0; i < 5; i++) expect((await sendOtp(sara)).status).toBe(200);
		const res = await sendOtp(sara);

		expect(res.status).toBe(429);
		expect(res.body.code).toBe("OTP_RATE_LIMITED");
		expect(sendAuthOtp).toHaveBeenCalledTimes(5);
	});

	test("a provider failure answers 502 and does not use up the hourly limit", async () => {
		const sara = await makeUser("Sara", 1);
		sendAuthOtp.mockResolvedValueOnce(false);

		const res = await sendOtp(sara);

		expect(res.status).toBe(502);
		expect((await OtpRequestLog.findOne({ phoneNumber: sara.phoneNumber })).count).toBe(0);
	});

});


describe("POST /api/account/delete/verify — AC-02 (correct code deletes the account)", () => {

	test("deletes the user and answers 200", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);

		const res = await confirm(sara);

		expect(res.status).toBe(200);
		expect(res.body.deleted).toBe(true);
		expect(verifyOtp).toHaveBeenCalledWith(sara.phoneNumber, "123456");
		expect(await User.findById(sara._id)).toBeNull();
		expect(await AccountDeletionOtp.countDocuments()).toBe(0);
	});

	test("a member is removed from the group; the group and its list stay", async () => {
		const [sara, omar] = [await makeUser("Sara", 1), await makeUser("Omar", 2)];
		const group = await makeGroup("Family", [{ user: sara, role: "creator" }, { user: omar, role: "member" }]);
		await addItem(group, sara);
		await sendOtp(omar);

		const res = await confirm(omar);

		expect(res.body.groups).toEqual({ deleted: 0, transferred: 0, removed: 1 });
		const after = await Group.findById(group._id);
		expect(after.members.map((m) => String(m.user))).toEqual([String(sara._id)]);
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

	test("an admin is removed when the creator is still there", async () => {
		const [sara, omar] = [await makeUser("Sara", 1), await makeUser("Omar", 2)];
		const group = await makeGroup("Family", [{ user: sara, role: "creator" }, { user: omar, role: "admin" }]);
		await sendOtp(omar);

		await confirm(omar);

		const after = await Group.findById(group._id);
		expect(after.members).toHaveLength(1);
		expect(after.roleOf(sara._id)).toBe("creator");
	});

	test("the creator leaves and the member who joined first after them becomes the Group Creator", async () => {
		const [sara, omar, ali] = [await makeUser("Sara", 1), await makeUser("Omar", 2), await makeUser("Ali", 3)];
		const group = await makeGroup("Family", [{ user: sara, role: "creator" }, { user: ali, role: "member" }, { user: omar, role: "admin" }]);
		await sendOtp(sara);

		const res = await confirm(sara);

		expect(res.body.groups).toEqual({ deleted: 0, transferred: 1, removed: 0 });
		const after = await Group.findById(group._id);
		expect(after.roleOf(sara._id)).toBeNull();
		expect(after.roleOf(ali._id)).toBe("creator");
		expect(after.roleOf(omar._id)).toBe("admin");
		expect(String(after.createdBy)).toBe(String(ali._id));
	});

	test("the hand-over goes by join date, not by the order members are stored in", async () => {
		const [sara, omar, ali] = [await makeUser("Sara", 1), await makeUser("Omar", 2), await makeUser("Ali", 3)];
		const group = await makeGroup("Family", [
			{ user: sara, role: "creator", joinedAt: new Date("2026-10-01") },
			{ user: omar, role: "member", joinedAt: new Date("2026-10-20") },
			{ user: ali, role: "member", joinedAt: new Date("2026-10-05") },
		]);
		await sendOtp(sara);

		await confirm(sara);

		const after = await Group.findById(group._id);
		expect(after.roleOf(ali._id)).toBe("creator");
		expect(after.roleOf(omar._id)).toBe("member");
	});

	test("the creator with only regular members: the group is kept and its list stays", async () => {
		const [sara, ali] = [await makeUser("Sara", 1), await makeUser("Ali", 3)];
		const group = await makeGroup("Family", [{ user: sara, role: "creator" }, { user: ali, role: "member" }]);
		await addItem(group, sara);
		await sendOtp(sara);

		const res = await confirm(sara);

		expect(res.body.groups).toEqual({ deleted: 0, transferred: 1, removed: 0 });
		const after = await Group.findById(group._id);
		expect(after.members).toHaveLength(1);
		expect(after.roleOf(ali._id)).toBe("creator");
		expect(await ListItem.countDocuments({ group: group._id })).toBe(1);
	});

	test("the group has exactly one Group Creator after the hand-over", async () => {
		const [sara, omar, ali] = [await makeUser("Sara", 1), await makeUser("Omar", 2), await makeUser("Ali", 3)];
		const group = await makeGroup("Family", [{ user: sara, role: "creator" }, { user: omar, role: "admin" }, { user: ali, role: "member" }]);
		await sendOtp(sara);

		await confirm(sara);

		const after = await Group.findById(group._id);
		expect(after.members.filter((m) => m.role === "creator")).toHaveLength(1);
	});

	test("a group with only the user in it is deleted", async () => {
		const sara = await makeUser("Sara", 1);
		const group = await makeGroup("Just me", [{ user: sara, role: "creator" }]);
		await sendOtp(sara);

		await confirm(sara);

		expect(await Group.findById(group._id)).toBeNull();
	});

	test("every group the user is in is handled, and other people's groups are untouched", async () => {
		const [sara, omar, ali] = [await makeUser("Sara", 1), await makeUser("Omar", 2), await makeUser("Ali", 3)];
		await makeGroup("Mine", [{ user: sara, role: "creator" }]);
		const shared = await makeGroup("Shared", [{ user: omar, role: "creator" }, { user: sara, role: "member" }]);
		const other = await makeGroup("Other", [{ user: omar, role: "creator" }, { user: ali, role: "member" }]);
		await sendOtp(sara);

		const res = await confirm(sara);

		expect(res.body.groups).toEqual({ deleted: 1, transferred: 0, removed: 1 });
		expect((await Group.findById(shared._id)).members).toHaveLength(1);
		// "Mine" had nobody else in it, so it is the one deleted
		expect((await Group.findById(other._id)).members).toHaveLength(2);
		expect(await Group.countDocuments({ "members.user": sara._id })).toBe(0);
	});

	test("other users' accounts are not touched", async () => {
		const [sara, omar] = [await makeUser("Sara", 1), await makeUser("Omar", 2)];
		await sendOtp(sara);

		await confirm(sara);

		expect(await User.findById(omar._id)).not.toBeNull();
	});

});


describe("POST /api/account/delete/verify — AC-04 (no more notifications)", () => {

	test("the user's push tokens are gone with the account", async () => {
		const sara = await makeUser("Sara", 1);
		await User.updateOne({ _id: sara._id }, { $set: { pushTokens: ["ExponentPushToken[abc]"] } });
		await sendOtp(sara);

		await confirm(sara);

		expect(await User.countDocuments({ pushTokens: "ExponentPushToken[abc]" })).toBe(0);
	});

});


describe("POST /api/account/delete/verify — AC-03 and the code rules", () => {

	test("a wrong code answers 400 OTP_INCORRECT with the attempts left, and nothing is deleted", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		verifyOtp.mockResolvedValue("invalid");

		const res = await confirm(sara, "000000");

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ code: "OTP_INCORRECT", attemptsRemaining: 4, error: "The code you entered is incorrect. Please try again." });
		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("after a wrong code the correct code still works", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		verifyOtp.mockResolvedValueOnce("invalid");

		await confirm(sara, "000000");
		const res = await confirm(sara);

		expect(res.status).toBe(200);
		expect(await User.findById(sara._id)).toBeNull();
	});

	test("the 5th wrong code locks the code; even the right code is then refused", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		verifyOtp.mockResolvedValue("invalid");

		for (let i = 0; i < 4; i++) expect((await confirm(sara, "000000")).status).toBe(400);
		const fifth = await confirm(sara, "000000");
		verifyOtp.mockResolvedValue("valid");
		const sixth = await confirm(sara);

		expect(fifth.status).toBe(429);
		expect(fifth.body.code).toBe("OTP_ATTEMPTS_EXCEEDED");
		expect(sixth.status).toBe(429);
		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("a code older than 60 seconds is refused without asking Authentica", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		await AccountDeletionOtp.updateOne({ user: sara._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

		const res = await confirm(sara);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_EXPIRED");
		expect(verifyOtp).not.toHaveBeenCalled();
		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("verifying without asking for a code first gets 400 OTP_NOT_FOUND", async () => {
		const sara = await makeUser("Sara", 1);

		const res = await confirm(sara);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_NOT_FOUND");
	});

	test("a provider failure answers 502, keeps the account and gives the attempt back", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		verifyOtp.mockResolvedValueOnce("error");

		const res = await confirm(sara);

		expect(res.status).toBe(502);
		expect(await User.findById(sara._id)).not.toBeNull();
		expect((await AccountDeletionOtp.findOne({ user: sara._id })).failedAttempts).toBe(0);
	});

	test("a new code replaces the old one and resets the attempts", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		verifyOtp.mockResolvedValue("invalid");
		await confirm(sara, "000000");

		await sendOtp(sara);

		expect((await AccountDeletionOtp.findOne({ user: sara._id })).failedAttempts).toBe(0);
	});

});


describe("POST /api/account/delete/verify — SF-14 confirmation and bad requests", () => {

	test("without confirmed: true the request is refused and the code is not checked", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);

		for (const body of [{ otp: "123456" }, { otp: "123456", confirmed: false }, { otp: "123456", confirmed: "true" }]) {
			const res = await verify(sara, body);
			expect(res.status).toBe(400);
			expect(res.body.code).toBe("CONFIRMATION_REQUIRED");
		}
		expect(verifyOtp).not.toHaveBeenCalled();
		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("a missing code gets 400", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);

		const res = await verify(sara, { confirmed: true });

		expect(res.status).toBe(400);
		expect(await User.findById(sara._id)).not.toBeNull();
	});

	test("a request without a token gets 401", async () => {
		const res = await request(app).post("/api/account/delete/verify").send({ otp: "123456", confirmed: true });

		expect(res.status).toBe(401);
	});

	test("one user's code cannot delete another account: the code is checked against the caller's own phone", async () => {
		const [sara, omar] = [await makeUser("Sara", 1), await makeUser("Omar", 2)];
		await sendOtp(sara);

		const res = await confirm(omar);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_NOT_FOUND");
		expect(await User.countDocuments()).toBe(2);
	});

	test("after deletion the same token can't delete again (404)", async () => {
		const sara = await makeUser("Sara", 1);
		await sendOtp(sara);
		await confirm(sara);

		const res = await confirm(sara);

		expect(res.status).toBe(404);
	});

});
