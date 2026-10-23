// US 01 AC-02: duplicate phone registration — isolated tests (Jest)
// Run from src/:  npm test
// Covers only code that exists on origin/login (User model + normalizeSaudiPhone).
// There is no registration endpoint yet, so the endpoint-level AC-02 tests are test.todo.
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../src/models/User");
const { normalizeSaudiPhone } = require("../src/utils/normalizeSaudiPhone");


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


// Blocked: needs POST /api/auth/register (not implemented on main or login).
describe("POST /api/auth/register with an already registered phone (AC-02)", () => {
	test.todo("responds 409 PHONE_ALREADY_REGISTERED with an 'already registered' message");
	test.todo("does not send an OTP or create a second user");
	test.todo("detects the duplicate when the phone is sent in another format (05…, 966…)");
});
