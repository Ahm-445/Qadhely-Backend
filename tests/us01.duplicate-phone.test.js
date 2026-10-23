// US 01 AC-02: duplicate phone registration — isolated tests (Jest)
// Run from src/:  npm test
// Covers the User model, normalizeSaudiPhone and POST /api/auth/register (AC-01, AC-02).
// Authentica is mocked: these tests do not prove real WhatsApp delivery.
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

jest.mock("../src/services/authentica"); // no real Authentica / WhatsApp calls

const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../src/models/User");
const { normalizeSaudiPhone } = require("../src/utils/normalizeSaudiPhone");
const { sendWhatsAppOtp } = require("../src/services/authentica");
const authRoutes = require("../src/routes/authRoutes");
const errorHandler = require("../src/middleware/errorHandler");


// small app with only the auth routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use(errorHandler);


let mongo;

beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us01" });
	await User.init(); // make sure the unique index exists before the tests insert
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	jest.clearAllMocks();
	sendWhatsAppOtp.mockResolvedValue(true);
	await User.deleteMany({});
});



describe("normalizeSaudiPhone (duplicate detection depends on it)", () => {

	test.each([
		"+966501234567",
		"00966501234567",
		"966501234567",
		"0501234567",
		"501234567",
		"05 0123-4567",
	])("%s normalizes to +966501234567", (input) => {
		expect(normalizeSaudiPhone(input)).toBe("+966501234567");
	});

	test.each([null, undefined, "", "12345", "+966401234567", "+971501234567"])(
		"%p is rejected",
		(input) => {
			expect(normalizeSaudiPhone(input)).toBeNull();
		}
	);
});


describe("User model phone uniqueness (AC-02)", () => {

	test("rejects a second user with the same phone number (duplicate key)", async () => {
		await User.create({ handleName: "first", phoneNumber: "+966501234567" });

		await expect(
			User.create({ handleName: "second", phoneNumber: "+966501234567" })
		).rejects.toMatchObject({ code: 11000 });

		expect(await User.countDocuments({ phoneNumber: "+966501234567" })).toBe(1);
	});

	test("rejects the same number written in another format once normalized", async () => {
		await User.create({
			handleName: "first",
			phoneNumber: normalizeSaudiPhone("0501234567"),
		});

		await expect(
			User.create({
				handleName: "second",
				phoneNumber: normalizeSaudiPhone("+966 50 123 4567"),
			})
		).rejects.toMatchObject({ code: 11000 });
	});

	test("allows the same handle name with a different phone number", async () => {
		await User.create({ handleName: "same", phoneNumber: "+966501234567" });

		await expect(
			User.create({ handleName: "same", phoneNumber: "+966501234568" })
		).resolves.toBeDefined();
	});

	test("lookup by normalized phone finds the registered user", async () => {
		await User.create({ handleName: "first", phoneNumber: "+966501234567" });

		const found = await User.findOne({ phoneNumber: normalizeSaudiPhone("0501234567") });
		expect(found).not.toBeNull();
		expect(found.handleName).toBe("first");
	});
});


describe("POST /api/auth/register (AC-02)", () => {

	const ALREADY_REGISTERED = { error: "This phone number is already registered." };

	test("returns 409 for an already registered phone number", async () => {
		await User.create({ handleName: "first", phoneNumber: "+966501234567" });

		const res = await request(app)
			.post("/api/auth/register")
			.send({ handleName: "second", phoneNumber: "+966501234567" });

		expect(res.status).toBe(409);
		expect(res.body).toEqual(ALREADY_REGISTERED);
	});

	test.each(["0501234567", "966501234567", "00966501234567", "501234567", "05 0123-4567"])(
		"returns 409 when the registered phone is sent as %s",
		async (phoneNumber) => {
			await User.create({ handleName: "first", phoneNumber: "+966501234567" });

			const res = await request(app)
				.post("/api/auth/register")
				.send({ handleName: "second", phoneNumber });

			expect(res.status).toBe(409);
			expect(res.body).toEqual(ALREADY_REGISTERED);
		}
	);

	test("does not create a second user on a duplicate", async () => {
		await User.create({ handleName: "first", phoneNumber: "+966501234567" });

		await request(app)
			.post("/api/auth/register")
			.send({ handleName: "second", phoneNumber: "0501234567" });

		expect(await User.countDocuments()).toBe(1);
	});

	test("does not send an OTP for a duplicate phone", async () => {
		await User.create({ handleName: "first", phoneNumber: "+966501234567" });

		await request(app)
			.post("/api/auth/register")
			.send({ handleName: "second", phoneNumber: "0501234567" });

		expect(sendWhatsAppOtp).not.toHaveBeenCalled();
	});

	test("AC-01: sends a WhatsApp OTP to the normalized phone and returns 200", async () => {
		const res = await request(app)
			.post("/api/auth/register")
			.send({ handleName: "newuser", phoneNumber: "0501234567" });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ sent: true, expiresInSeconds: 60 });
		expect(sendWhatsAppOtp).toHaveBeenCalledTimes(1);
		expect(sendWhatsAppOtp).toHaveBeenCalledWith("+966501234567");
	});

	test("does not create the user before OTP verification", async () => {
		await request(app)
			.post("/api/auth/register")
			.send({ handleName: "newuser", phoneNumber: "0501234567" });

		expect(await User.countDocuments()).toBe(0);
	});

	test("returns 502 with a generic message when the provider fails", async () => {
		sendWhatsAppOtp.mockResolvedValue(false);

		const res = await request(app)
			.post("/api/auth/register")
			.send({ handleName: "newuser", phoneNumber: "0501234567" });

		expect(res.status).toBe(502);
		expect(res.body).toEqual({ error: "Could not send the verification code. Please try again." });
		expect(res.body.sent).toBeUndefined();
		expect(await User.countDocuments()).toBe(0);
	});

	test("does not call the provider for invalid input", async () => {
		await request(app).post("/api/auth/register").send({ handleName: "abc", phoneNumber: "12345" });
		await request(app).post("/api/auth/register").send({ handleName: "", phoneNumber: "0501234567" });

		expect(sendWhatsAppOtp).not.toHaveBeenCalled();
	});

	test.each([
		["missing handleName", { phoneNumber: "0501234567" }],
		["blank handleName", { handleName: "   ", phoneNumber: "0501234567" }],
		["non-string handleName", { handleName: 5, phoneNumber: "0501234567" }],
	])("returns 400 for %s", async (_name, body) => {
		const res = await request(app).post("/api/auth/register").send(body);
		expect(res.status).toBe(400);
	});

	test.each([
		["missing phoneNumber", { handleName: "abc" }],
		["non-Saudi phoneNumber", { handleName: "abc", phoneNumber: "+971501234567" }],
		["malformed phoneNumber", { handleName: "abc", phoneNumber: "12345" }],
	])("returns 400 for %s", async (_name, body) => {
		const res = await request(app).post("/api/auth/register").send(body);
		expect(res.status).toBe(400);
	});
});
