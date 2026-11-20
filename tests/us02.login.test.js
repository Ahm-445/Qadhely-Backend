// US 02: Login with OTP — API tests (Jest + Supertest)
//
// POST /api/auth/loginSendOTP  { phoneNumber }        → 200 { sent: true }
// POST /api/auth/loginRecieveOTP { phoneNumber, otp } → 200 { message, token, id, handleName, phoneNumber }
//
// Authentica is reached through global fetch inside authController, which is stubbed here: no real
// messages are sent and no request leaves the machine.
//
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";
delete process.env.JWT_EXPIRE;

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const authRoutes = require("../src/routes/authRoutes");
const groupRoutes = require("../src/routes/groupRoutes");
const User = require("../src/models/User");


const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/groups", groupRoutes);


const AUTHENTICA_SEND = "https://api.authentica.sa/api/v2/send-otp";
const AUTHENTICA_VERIFY = "https://api.authentica.sa/api/v2/verify-otp";

const PHONE = "+966551234567";

let mongo;

// what Authentica answers; the controller only reads ok, status and the JSON body
function stubAuthentica({ ok = true, status = 200, body = { success: true } } = {}) {
	global.fetch = jest.fn().mockResolvedValue({ ok, status, json: async () => body });
	return global.fetch;
}

const sentBody = (call) => JSON.parse(call[1].body);
const sentUrl = (call) => call[0];

const sendOtp = (body) => request(app).post("/api/auth/loginSendOTP").send(body);
const verifyOtp = (body) => request(app).post("/api/auth/loginRecieveOTP").send(body);

const makeUser = (handleName = "Sara", phoneNumber = PHONE) => User.create({ handleName, phoneNumber });


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us02" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await User.deleteMany({});
	// the controller logs provider failures; keep the test output readable
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
	delete global.fetch;
});


describe("POST /api/auth/loginSendOTP", () => {

	test("a registered number gets a code and answers { sent: true }", async () => {
		const user = await makeUser();
		const fetch = stubAuthentica();

		const res = await sendOtp({ phoneNumber: user.phoneNumber });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ sent: true });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("the code is sent to the registered number as an SMS", async () => {
		const user = await makeUser();
		const fetch = stubAuthentica();

		await sendOtp({ phoneNumber: user.phoneNumber });

		const call = fetch.mock.calls[0];

		expect(sentUrl(call)).toBe(AUTHENTICA_SEND);
		expect(sentBody(call)).toEqual({ method: "sms", phone: PHONE });
		expect(call[1].headers["X-Authorization"]).toBe(process.env.AUTHENTICA_API_KEY);
	});

	test("the number is normalized before it reaches Authentica", async () => {
		await makeUser();
		const fetch = stubAuthentica();

		const res = await sendOtp({ phoneNumber: "055 123 4567" });

		expect(res.status).toBe(200);
		expect(sentBody(fetch.mock.calls[0])).toEqual({ method: "sms", phone: PHONE });
	});

	test("an unregistered number gets 401 and no code is sent", async () => {
		const fetch = stubAuthentica();

		const res = await sendOtp({ phoneNumber: "+966550000000" });

		expect(res.status).toBe(401);
		expect(res.body.error).toMatch(/register/i);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("an invalid number gets 400 and no code is sent", async () => {
		const fetch = stubAuthentica();

		for (const phoneNumber of ["12345", "", undefined, "not a phone"]) {
			const res = await sendOtp({ phoneNumber });
			expect(res.status).toBe(400);
		}

		expect(fetch).not.toHaveBeenCalled();
	});

	test("a refusal from Authentica gets 502 with its message", async () => {
		const user = await makeUser();
		stubAuthentica({ ok: false, status: 400, body: { success: false, message: "Monthly limit reached" } });

		const res = await sendOtp({ phoneNumber: user.phoneNumber });

		expect(res.status).toBe(502);
		expect(res.body.error).toBe("Monthly limit reached");
	});

	test("Authentica answering without success:true also gets 502", async () => {
		const user = await makeUser();
		stubAuthentica({ ok: true, status: 200, body: { success: false } });

		const res = await sendOtp({ phoneNumber: user.phoneNumber });

		expect(res.status).toBe(502);
	});

	test("an unreachable provider gets 500", async () => {
		const user = await makeUser();
		global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

		const res = await sendOtp({ phoneNumber: user.phoneNumber });

		expect(res.status).toBe(500);
		expect(res.body.error).toBe("Failed to send otp");
	});

});


describe("POST /api/auth/loginRecieveOTP", () => {

	test("a correct code answers with a token and the user's details", async () => {
		const user = await makeUser();
		stubAuthentica({ body: { status: true } });

		const res = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });

		expect(res.status).toBe(200);
		expect(res.body.message).toBe("login successful");
		expect(res.body.id).toBe(String(user._id));
		expect(res.body.handleName).toBe("Sara");
		expect(res.body.phoneNumber).toBe(PHONE);
		expect(typeof res.body.token).toBe("string");
	});

	test("the code is checked with Authentica against the registered number", async () => {
		const user = await makeUser();
		const fetch = stubAuthentica({ body: { status: true } });

		await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });

		const call = fetch.mock.calls[0];

		expect(sentUrl(call)).toBe(AUTHENTICA_VERIFY);
		expect(sentBody(call)).toEqual({ phone: PHONE, otp: "123456" });
	});

	test("the token carries the user and is accepted by a protected route", async () => {
		const user = await makeUser();
		stubAuthentica({ body: { status: true } });

		const login = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });
		const decoded = jwt.verify(login.body.token, process.env.JWT_SECRET);
		const groups = await request(app).get("/api/groups").set("Authorization", `Bearer ${login.body.token}`);

		expect(String(decoded.id)).toBe(String(user._id));
		expect(decoded.handleName).toBe("Sara");
		expect(decoded.phoneNumber).toBe(PHONE);
		expect(groups.status).toBe(200);
	});

	test("the token lasts 30 days when JWT_EXPIRE is not set", async () => {
		const user = await makeUser();
		stubAuthentica({ body: { status: true } });

		const res = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });
		const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET);

		expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
	});

	test("a wrong code gets 401 and no token", async () => {
		const user = await makeUser();
		stubAuthentica({ body: { status: false } });

		const res = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "000000" });

		expect(res.status).toBe(401);
		expect(res.body.token).toBeUndefined();
	});

	test("an unregistered number gets 401 before Authentica is asked", async () => {
		const fetch = stubAuthentica({ body: { status: true } });

		const res = await verifyOtp({ phoneNumber: "+966550000000", otp: "123456" });

		expect(res.status).toBe(401);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("a missing code gets 400", async () => {
		const user = await makeUser();
		const fetch = stubAuthentica({ body: { status: true } });

		const res = await verifyOtp({ phoneNumber: user.phoneNumber });

		expect(res.status).toBe(400);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("a rejected provider call gets 401 with the provider's message", async () => {
		const user = await makeUser();
		stubAuthentica({ ok: false, status: 500, body: { message: "Authentica is down" } });

		const res = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });

		expect(res.status).toBe(401);
		expect(res.body.error).toBe("Authentica is down");
		expect(res.body.token).toBeUndefined();
	});

	test("an unreachable provider gets 500", async () => {
		const user = await makeUser();
		global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

		const res = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });

		expect(res.status).toBe(500);
		expect(res.body.error).toBe("Failed to login");
	});

	test("logging in twice answers a working token both times", async () => {
		const user = await makeUser();
		stubAuthentica({ body: { status: true } });

		const first = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });
		const second = await verifyOtp({ phoneNumber: user.phoneNumber, otp: "123456" });

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(jwt.verify(second.body.token, process.env.JWT_SECRET).id).toBe(String(user._id));
	});

});
