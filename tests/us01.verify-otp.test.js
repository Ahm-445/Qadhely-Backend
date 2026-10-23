// US 01 AC-03 / AC-04 and NFR-01: registration OTP verification — API tests (Jest + Supertest)
// Run from src/:  npm test
// Authentica is mocked: these tests do not prove real WhatsApp delivery or real provider responses.
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

jest.mock("../src/services/authentica");

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../src/models/User");
const RegistrationOtp = require("../src/models/RegistrationOtp");
const OtpRequestLog = require("../src/models/OtpRequestLog");
const { sendWhatsAppOtp, verifyOtp } = require("../src/services/authentica");
const authRoutes = require("../src/routes/authRoutes");


// small app with only the auth routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

const PHONE = "+966501234567";

let mongo;

const register = (body = { handleName: "newuser", phoneNumber: "0501234567" }) =>
	request(app).post("/api/auth/register").send(body);

const verify = (otp = "123456", phoneNumber = "0501234567") =>
	request(app).post("/api/auth/verify-otp").send({ phoneNumber, otp });


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us01_verify" });
	await Promise.all([User.init(), RegistrationOtp.init(), OtpRequestLog.init()]);
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	jest.clearAllMocks();
	sendWhatsAppOtp.mockResolvedValue(true);
	verifyOtp.mockResolvedValue("valid");
	jest.spyOn(console, "error").mockImplementation(() => {});
	await Promise.all([User.deleteMany({}), RegistrationOtp.deleteMany({}), OtpRequestLog.deleteMany({})]);
});

afterEach(() => {
	jest.restoreAllMocks();
});



describe("POST /api/auth/verify-otp — success (AC-03)", () => {

	test("creates the user only after verification and returns the Login-style JWT response", async () => {
		await register();
		expect(await User.countDocuments()).toBe(0);

		const res = await verify();

		expect(res.status).toBe(201);
		expect(verifyOtp).toHaveBeenCalledWith(PHONE, "123456");
		expect(res.body).toMatchObject({ message: "registration successful", handleName: "newuser", phoneNumber: PHONE });
		expect(res.body.id).toBeDefined();

		const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
		expect(payload).toMatchObject({ id: res.body.id, handleName: "newuser", phoneNumber: PHONE });

		const user = await User.findOne({ phoneNumber: PHONE });
		expect(user).not.toBeNull();
		expect(String(user._id)).toBe(res.body.id);
	});

	test("accepts the phone in another format and a numeric otp", async () => {
		await register();

		const res = await request(app).post("/api/auth/verify-otp").send({ phoneNumber: "966501234567", otp: 123456 });

		expect(res.status).toBe(201);
		expect(verifyOtp).toHaveBeenCalledWith(PHONE, "123456");
	});
});


describe("POST /api/auth/verify-otp — incorrect code (AC-04)", () => {

	test("returns 400 with attemptsRemaining and creates no user", async () => {
		await register();
		verifyOtp.mockResolvedValue("invalid");

		const res = await verify("000000");

		expect(res.status).toBe(400);
		expect(res.body).toEqual({
			error: "The code you entered is incorrect. Please try again.",
			code: "OTP_INCORRECT",
			attemptsRemaining: 4
		});
		expect(await User.countDocuments()).toBe(0);
	});

	test("the user can retry with the correct code after a wrong one", async () => {
		await register();
		verifyOtp.mockResolvedValueOnce("invalid");

		expect((await verify("000000")).status).toBe(400);
		expect((await verify("123456")).status).toBe(201);
	});

	test("invalidates the code after 5 wrong attempts, even if the 6th is correct", async () => {
		await register();
		verifyOtp.mockResolvedValue("invalid");

		for (let i = 1; i <= 4; i++) {
			const res = await verify("000000");
			expect(res.status).toBe(400);
			expect(res.body.attemptsRemaining).toBe(5 - i);
		}

		const fifth = await verify("000000");
		expect(fifth.status).toBe(429);
		expect(fifth.body.code).toBe("OTP_ATTEMPTS_EXCEEDED");

		verifyOtp.mockResolvedValue("valid");
		verifyOtp.mockClear();

		const sixth = await verify("123456");
		expect(sixth.status).toBe(429);
		expect(sixth.body.code).toBe("OTP_ATTEMPTS_EXCEEDED");
		expect(verifyOtp).not.toHaveBeenCalled();
		expect(await User.countDocuments()).toBe(0);
	});

	test("a new OTP request after invalidation allows registration again", async () => {
		await register();
		verifyOtp.mockResolvedValue("invalid");
		for (let i = 0; i < 5; i++) await verify("000000");

		await register();
		verifyOtp.mockResolvedValue("valid");

		expect((await verify("123456")).status).toBe(201);
	});
});


describe("POST /api/auth/verify-otp — expiry and single use (NFR-01)", () => {

	test("rejects an expired code in application logic without calling the provider", async () => {
		await register();
		await RegistrationOtp.updateOne({ phoneNumber: PHONE }, { expiresAt: new Date(Date.now() - 1000) });

		const res = await verify();

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_EXPIRED");
		expect(verifyOtp).not.toHaveBeenCalled();
		expect(await User.countDocuments()).toBe(0);
	});

	test("sets a 60 second expiry when the code is sent", async () => {
		await register();

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.expiresAt.getTime() - pending.sentAt.getTime()).toBe(60 * 1000);
	});

	test("rejects reuse of a code that already registered the user", async () => {
		await register();
		expect((await verify()).status).toBe(201);
		verifyOtp.mockClear();

		const res = await verify();

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_ALREADY_USED");
		expect(verifyOtp).not.toHaveBeenCalled();
		expect(await User.countDocuments()).toBe(1);
	});

	test("returns 400 when there is no pending registration", async () => {
		const res = await verify();

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_NOT_FOUND");
		expect(verifyOtp).not.toHaveBeenCalled();
	});

	test("two concurrent correct verifications create exactly one user", async () => {
		await register();

		const [a, b] = await Promise.all([verify(), verify()]);

		expect([a.status, b.status].sort()).toEqual([201, 400]);
		expect(await User.countDocuments()).toBe(1);
	});
});


describe("POST /api/auth/verify-otp — failures and duplicates", () => {

	test("returns 502 on a provider error and does not burn an attempt", async () => {
		await register();
		verifyOtp.mockResolvedValueOnce("error");

		const res = await verify();

		expect(res.status).toBe(502);
		expect(res.body).toEqual({ error: "Could not verify the code. Please try again." });
		expect((await RegistrationOtp.findOne({ phoneNumber: PHONE })).failedAttempts).toBe(0);
		expect(await User.countDocuments()).toBe(0);

		expect((await verify()).status).toBe(201);
	});

	test("returns 409 when the phone was registered between register and verify", async () => {
		await register();
		await User.create({ handleName: "someone", phoneNumber: PHONE });

		const res = await verify();

		expect(res.status).toBe(409);
		expect(res.body).toEqual({ error: "This phone number is already registered." });
		expect(await User.countDocuments()).toBe(1);
	});

	test("returns 500 with a generic message on an unexpected database error and allows a retry", async () => {
		await register();
		jest.spyOn(User.prototype, "save").mockRejectedValueOnce(new Error("secret db detail"));

		const res = await verify();

		expect(res.status).toBe(500);
		expect(JSON.stringify(res.body)).not.toContain("secret db detail");
		expect(await User.countDocuments()).toBe(0);

		expect((await verify()).status).toBe(201);
	});

	test("a database failure after the code is consumed puts it back so the user can retry", async () => {
		await register();
		jest.spyOn(User.prototype, "save").mockRejectedValueOnce(new Error("db down"));

		expect((await verify()).status).toBe(500);

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.status).toBe("pending");
	});

	test("returns 500 and leaves the code usable when JWT_SECRET is missing", async () => {
		await register();
		const secret = process.env.JWT_SECRET;
		delete process.env.JWT_SECRET;

		try {
			const res = await verify();
			expect(res.status).toBe(500);
			expect(verifyOtp).not.toHaveBeenCalled();
			expect(await User.countDocuments()).toBe(0);
		}
		finally {
			process.env.JWT_SECRET = secret;
		}

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.status).toBe("pending");
		expect(pending.failedAttempts).toBe(0);
		expect((await verify()).status).toBe(201);
	});

	test("returns 500 and leaves the code usable when the JWT options are invalid", async () => {
		await register();
		process.env.JWT_EXPIRE = "not-a-duration";

		try {
			expect((await verify()).status).toBe(500);
		}
		finally {
			delete process.env.JWT_EXPIRE;
		}

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.status).toBe("pending");
		expect(pending.failedAttempts).toBe(0);
		expect(await User.countDocuments()).toBe(0);
		expect((await verify()).status).toBe(201);
	});

	test.each([
		["missing phoneNumber", { otp: "123456" }],
		["invalid phoneNumber", { phoneNumber: "12345", otp: "123456" }],
		["missing otp", { phoneNumber: "0501234567" }],
		["blank otp", { phoneNumber: "0501234567", otp: "  " }],
	])("returns 400 for %s", async (_name, body) => {
		const res = await request(app).post("/api/auth/verify-otp").send(body);

		expect(res.status).toBe(400);
		expect(verifyOtp).not.toHaveBeenCalled();
	});
});


describe("OTP resend while a verification is in progress", () => {

	test("a stale verification does not consume the newer code", async () => {
		await register();
		verifyOtp.mockImplementationOnce(async () => {
			await register(); // the user asks for a new code while the old one is being checked
			return "valid";
		});

		const res = await verify("111111");

		expect(res.status).toBe(400);
		expect(res.body.code).toBe("OTP_REPLACED");
		expect(await User.countDocuments()).toBe(0);

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.status).toBe("pending");

		expect((await verify("222222")).status).toBe(201);
	});

	test("a stale 5th wrong attempt does not invalidate the newer code", async () => {
		await register();
		verifyOtp.mockResolvedValue("invalid");
		for (let i = 0; i < 4; i++) await verify("000000");

		verifyOtp.mockImplementationOnce(async () => {
			await register();
			return "invalid";
		});
		await verify("000000");

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.status).toBe("pending");
		expect(pending.failedAttempts).toBe(0);

		verifyOtp.mockResolvedValue("valid");
		expect((await verify("222222")).status).toBe(201);
	});

	test("a stale provider error does not change the newer code's attempts", async () => {
		await register();
		verifyOtp.mockResolvedValue("invalid");
		await verify("000000");

		verifyOtp.mockImplementationOnce(async () => {
			await register();
			return "error";
		});
		expect((await verify("000000")).status).toBe(502);

		expect((await RegistrationOtp.findOne({ phoneNumber: PHONE })).failedAttempts).toBe(0);
	});
});


describe("POST /api/auth/register — hourly OTP limit (NFR-01)", () => {

	test("concurrent requests never exceed the limit and leave a consistent count", async () => {
		const results = await Promise.all(Array.from({ length: 8 }, () => register()));
		const statuses = results.map((r) => r.status).sort();

		expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
		expect(sendWhatsAppOtp).toHaveBeenCalledTimes(5);
		expect((await OtpRequestLog.findOne({ phoneNumber: PHONE })).count).toBe(5);
		expect(await RegistrationOtp.countDocuments()).toBe(1);
	});

	test("blocked requests do not stop a refund from freeing the quota", async () => {
		for (let i = 0; i < 5; i++) await register();
		for (let i = 0; i < 3; i++) expect((await register()).status).toBe(429);

		expect((await OtpRequestLog.findOne({ phoneNumber: PHONE })).count).toBe(5);
	});

	test("allows 5 requests per phone per hour and blocks the 6th", async () => {
		for (let i = 0; i < 5; i++) {
			expect((await register()).status).toBe(200);
		}

		const res = await register();

		expect(res.status).toBe(429);
		expect(res.body.code).toBe("OTP_RATE_LIMITED");
		expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
		expect(sendWhatsAppOtp).toHaveBeenCalledTimes(5);
	});

	test("counts requests per phone number", async () => {
		for (let i = 0; i < 5; i++) await register();

		const other = await register({ handleName: "other", phoneNumber: "0507654321" });

		expect(other.status).toBe(200);
	});

	test("the limit survives deleting or expiring the pending OTP records", async () => {
		for (let i = 0; i < 5; i++) await register();
		await RegistrationOtp.deleteMany({});

		expect((await register()).status).toBe(429);
	});

	test("starts a new window once the hour has passed", async () => {
		for (let i = 0; i < 5; i++) await register();
		await OtpRequestLog.updateOne({ phoneNumber: PHONE }, { windowStart: new Date(Date.now() - 61 * 60 * 1000) });

		expect((await register()).status).toBe(200);
		expect((await OtpRequestLog.findOne({ phoneNumber: PHONE })).count).toBe(1);
	});

	test("a failed send does not use up the quota", async () => {
		sendWhatsAppOtp.mockResolvedValue(false);
		for (let i = 0; i < 6; i++) expect((await register()).status).toBe(502);

		sendWhatsAppOtp.mockResolvedValue(true);
		for (let i = 0; i < 5; i++) expect((await register()).status).toBe(200);
		expect((await register()).status).toBe(429);
	});

	test("a duplicate phone is rejected before using any quota", async () => {
		await User.create({ handleName: "first", phoneNumber: PHONE });

		expect((await register()).status).toBe(409);
		expect(await OtpRequestLog.countDocuments()).toBe(0);
	});

	test("a new request replaces the pending registration and resets its attempts", async () => {
		await register({ handleName: "first", phoneNumber: "0501234567" });
		verifyOtp.mockResolvedValueOnce("invalid");
		await verify("000000");

		await register({ handleName: "second", phoneNumber: "0501234567" });

		const pending = await RegistrationOtp.findOne({ phoneNumber: PHONE });
		expect(pending.handleName).toBe("second");
		expect(pending.failedAttempts).toBe(0);
		expect(await RegistrationOtp.countDocuments()).toBe(1);
	});
});
