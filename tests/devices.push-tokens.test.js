// Push token linking — API tests (Jest + Supertest)
// POST /api/devices links the phone's token on login; DELETE /api/devices/:pushToken
// unlinks it on logout, so a notification is not sent to a phone that is logged out.
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const devicesRoute = require("../src/routes/devicesRoute");
const User = require("../src/models/User");


// small app with only the device routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/devices", devicesRoute);


let mongo;

// same token shape as authRoutes.js login
const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

// real Expo tokens contain brackets, so the app has to send them URL-encoded
const EXPO_TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
const OTHER_TOKEN = "ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]";
const deviceUrl = (pushToken) => `/api/devices/${encodeURIComponent(pushToken)}`;

async function makeUsers(n) {
	const docs = Array.from({ length: n }, (_, i) => ({
		handleName: `user${i}`,
		phoneNumber: `+96655${String(i).padStart(7, "0")}`,
	}));
	return User.insertMany(docs);
}

const link = (user, ...tokens) => User.updateOne({ _id: user._id }, { $set: { pushTokens: tokens } });

const tokensOf = async (user) => (await User.findById(user._id)).pushTokens;


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_devices" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await User.deleteMany({});
});



describe("POST /api/devices", () => {

	test("links the phone's push token to the logged-in user", async () => {
		const [me] = await makeUsers(1);

		const res = await request(app)
			.post("/api/devices")
			.set("Authorization", tokenFor(me))
			.send({ pushToken: EXPO_TOKEN });

		expect(res.status).toBe(200);
		expect(await tokensOf(me)).toEqual([EXPO_TOKEN]);
	});

	test("is idempotent: logging in again keeps a single copy", async () => {
		const [me] = await makeUsers(1);

		await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: EXPO_TOKEN });
		const res = await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: EXPO_TOKEN });

		expect(res.status).toBe(200);
		expect(await tokensOf(me)).toEqual([EXPO_TOKEN]);
	});

	test("keeps other tokens of the same user", async () => {
		const [me] = await makeUsers(1);
		await link(me, OTHER_TOKEN);

		await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: EXPO_TOKEN });

		expect(await tokensOf(me)).toEqual([OTHER_TOKEN, EXPO_TOKEN]);
	});

	test("moves the token to the account that is logged in on the phone now", async () => {
		const [me, other] = await makeUsers(2);
		await link(other, EXPO_TOKEN);

		const res = await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: EXPO_TOKEN });

		expect(res.status).toBe(200);
		expect(await tokensOf(me)).toEqual([EXPO_TOKEN]);
		expect(await tokensOf(other)).toEqual([]);
	});

	test("rejects a blank or missing token", async () => {
		const [me] = await makeUsers(1);

		const r1 = await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({});
		const r2 = await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: "   " });
		const r3 = await request(app).post("/api/devices").set("Authorization", tokenFor(me)).send({ pushToken: "x".repeat(256) });

		expect(r1.status).toBe(400);
		expect(r2.status).toBe(400);
		expect(r3.status).toBe(400);
		expect(await tokensOf(me)).toEqual([]);
	});

	test("rejects a missing or invalid token", async () => {
		const [me] = await makeUsers(1);

		const r1 = await request(app).post("/api/devices").send({ pushToken: EXPO_TOKEN });
		const r2 = await request(app).post("/api/devices").set("Authorization", "Bearer bad").send({ pushToken: EXPO_TOKEN });

		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
		expect(await tokensOf(me)).toEqual([]);
	});

});



describe("DELETE /api/devices/:pushToken", () => {

	test("unlinks the phone's push token from the logged-in user", async () => {
		const [me] = await makeUsers(1);
		await link(me, EXPO_TOKEN);

		const res = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", tokenFor(me));

		expect(res.status).toBe(200);
		expect(await tokensOf(me)).toEqual([]);
	});

	test("removes only the token it was given", async () => {
		const [me] = await makeUsers(1);
		await link(me, EXPO_TOKEN, OTHER_TOKEN);

		const res = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", tokenFor(me));

		expect(res.status).toBe(200);
		expect(await tokensOf(me)).toEqual([OTHER_TOKEN]);
	});

	test("never unlinks another user's token", async () => {
		const [me, other] = await makeUsers(2);
		await link(other, EXPO_TOKEN);

		const res = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", tokenFor(me));

		expect(res.status).toBe(200);
		expect(await tokensOf(other)).toEqual([EXPO_TOKEN]);
	});

	test("is idempotent: a second logout is not an error", async () => {
		const [me] = await makeUsers(1);
		await link(me, EXPO_TOKEN);

		const first = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", tokenFor(me));
		const second = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", tokenFor(me));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
	});

	test("rejects a missing or invalid token", async () => {
		const [me] = await makeUsers(1);
		await link(me, EXPO_TOKEN);

		const r1 = await request(app).delete(deviceUrl(EXPO_TOKEN));
		const r2 = await request(app).delete(deviceUrl(EXPO_TOKEN)).set("Authorization", "Bearer bad");

		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
		expect(await tokensOf(me)).toEqual([EXPO_TOKEN]);
	});

	test("rejects a blank token", async () => {
		const [me] = await makeUsers(1);

		const res = await request(app).delete("/api/devices/%20").set("Authorization", tokenFor(me));

		expect(res.status).toBe(400);
		expect(res.body.error).toBeDefined();
	});

});
