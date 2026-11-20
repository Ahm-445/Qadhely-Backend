// AI suggestions — GET /api/groups/:groupId/suggestions
//
// US 23: an admin sees the items the model expects on the group's next list, built from the group's
// completed trips. A regular member does not, an item already on the list is never suggested, and a group
// with too little history says so with NOT_ENOUGH_HISTORY instead of guessing.
//
// The history is the fixture ml/generate_data.py wrote: a household the model never trained on, placed
// relative to now, so the same request always gives the same suggestions.
//
// Run from src/:  npm test -- us23.suggestions

process.env.JWT_SECRET = "test-secret";

jest.mock("../src/services/authentica");

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");
const ItemHistory = require("../src/models/ItemHistory");
const { MODEL } = require("../src/services/suggestions");
const fixture = require("../ml/out/criterion3_fixture.json");

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);

let mongo;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

const suggestions = (groupId, user) => {
	const req = request(app).get(`/api/groups/${groupId}/suggestions`);
	if (user) req.set("Authorization", tokenFor(user));
	return req;
};

const addItem = (groupId, user, body) =>
	request(app).post(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user)).send(body);

const setStatus = (groupId, itemId, user) =>
	request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`).set("Authorization", tokenFor(user)).send({ status: "found" });


async function makeGroup() {
	const [creator, admin, member, outsider] = await User.insertMany(["Sara", "Omar", "Ali", "Noura"].map((handleName, i) => ({
		handleName,
		phoneNumber: `+96655${String(i).padStart(7, "0")}`,
	})));

	const group = await Group.create({
		name: "Family groceries",
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
			{ user: member._id, role: "member" },
		],
	});

	return { creator, admin, member, outsider, group };
}


// the fixture's trips, placed so the last one was daysBeforeNow before the moment we ask
async function seedHistory(group, user, trips = fixture.trips) {
	const now = Date.now();
	const rows = [];

	for (const trip of trips) {
		const completed = now - Math.round(trip.daysBeforeNow * DAY_MS);
		const tripId = new mongoose.Types.ObjectId();

		trip.items.forEach((item, offset) => {
			rows.push({
				group: group._id,
				tripId,
				catalogItemId: item.catalogItemId,
				quantity: item.quantity,
				unit: item.unit,
				addedBy: user._id,
				addedAt: new Date(completed - (trip.items.length - offset) * MINUTE_MS),
				createdAt: new Date(completed),
				status: item.status,
			});
		});
	}

	await ItemHistory.insertMany(rows);
}


beforeAll(async () => {
	mongo = await MongoMemoryServer.create();
	await mongoose.connect(process.env.TEST_MONGO_URI || mongo.getUri(), { dbName: "suggestions" });
});

afterAll(async () => {
	await mongoose.disconnect();
	await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([
		User.deleteMany({}),
		Group.deleteMany({}),
		ListItem.deleteMany({}),
		ItemHistory.deleteMany({}),
	]);
});


describe("who may read the suggestions", () => {

	test("an admin gets the suggestions built from the group's trips", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const res = await suggestions(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.groupId).toBe(String(group._id));
		expect(res.body.modelVersion).toBe(MODEL.version);
		expect(res.body.code).toBeNull();
		expect(res.body.suggestions.length).toBeGreaterThan(0);
		expect(res.body.suggestions.length).toBeLessThanOrEqual(MODEL.maxSuggestions);
	});

	test("the Group Creator gets them too", async () => {
		const { creator, group } = await makeGroup();
		await seedHistory(group, creator);

		const res = await suggestions(group._id, creator);

		expect(res.status).toBe(200);
		expect(res.body.suggestions.length).toBeGreaterThan(0);
	});

	test("a regular member gets 403", async () => {
		const { admin, member, group } = await makeGroup();
		await seedHistory(group, admin);

		const res = await suggestions(group._id, member);

		expect(res.status).toBe(403);
	});

	test("someone outside the group gets 403", async () => {
		const { admin, outsider, group } = await makeGroup();
		await seedHistory(group, admin);

		const res = await suggestions(group._id, outsider);

		expect(res.status).toBe(403);
	});

	test("a request with no token gets 401", async () => {
		const { group } = await makeGroup();

		const res = await suggestions(group._id, null);

		expect(res.status).toBe(401);
	});

	test("an invalid group id gets 400", async () => {
		const { admin } = await makeGroup();

		const res = await suggestions("not-an-id", admin);

		expect(res.status).toBe(400);
	});

	test("a group that does not exist gets 404", async () => {
		const { admin } = await makeGroup();

		const res = await suggestions(new mongoose.Types.ObjectId(), admin);

		expect(res.status).toBe(404);
	});

});


describe("what a suggestion contains", () => {

	test("each one has a catalog item, a probability, a reason and the usual quantity", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const res = await suggestions(group._id, admin);

		for (const suggestion of res.body.suggestions) {
			expect(typeof suggestion.catalogItemId).toBe("string");
			expect(suggestion.catalogItem.id).toBe(suggestion.catalogItemId);
			expect(typeof suggestion.catalogItem.name_en).toBe("string");
			expect(suggestion.probability).toBeGreaterThanOrEqual(MODEL.threshold);
			expect(suggestion.probability).toBeLessThanOrEqual(1);
			expect(typeof suggestion.reason).toBe("string");
			expect(suggestion.reason.length).toBeGreaterThan(0);
			expect(Number.isFinite(suggestion.suggestedQuantity)).toBe(true);
			expect(["kg", "piece", "box"]).toContain(suggestion.suggestedUnit);
		}
	});

	test("they are sorted from the most to the least likely", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const { body } = await suggestions(group._id, admin);
		const probabilities = body.suggestions.map((suggestion) => suggestion.probability);

		expect(probabilities).toEqual([...probabilities].sort((a, b) => b - a));
	});

	test("the reason names the rhythm and the last purchase", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const { body } = await suggestions(group._id, admin);

		expect(body.suggestions.some((suggestion) => /days?, last bought \d+ days? ago/.test(suggestion.reason))).toBe(true);
	});

});


describe("the suggestions respect the current list and the history", () => {

	test("an item already on the list is not suggested", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const first = await suggestions(group._id, admin);
		const onList = first.body.suggestions[0].catalogItemId;

		const added = await addItem(group._id, admin, { catalogItemId: onList, quantity: 1, unit: "piece" });
		expect(added.status).toBe(201);

		const second = await suggestions(group._id, admin);

		expect(second.body.suggestions.map((suggestion) => suggestion.catalogItemId)).not.toContain(onList);
	});

	test("a group with fewer completed trips than the model needs gets NOT_ENOUGH_HISTORY", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin, fixture.trips.slice(0, MODEL.minTrips - 1));

		const res = await suggestions(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.code).toBe("NOT_ENOUGH_HISTORY");
		expect(res.body.suggestions).toEqual([]);
	});

	test("a group with no history at all gets NOT_ENOUGH_HISTORY, not an error", async () => {
		const { admin, group } = await makeGroup();

		const res = await suggestions(group._id, admin);

		expect(res.status).toBe(200);
		expect(res.body.code).toBe("NOT_ENOUGH_HISTORY");
		expect(res.body.suggestions).toEqual([]);
	});

	test("an item added to the list but never bought is not a suggestion", async () => {
		const { admin, group } = await makeGroup();
		await seedHistory(group, admin);

		const added = await addItem(group._id, admin, { catalogItemId: "tamimi-1001", quantity: 1, unit: "piece" });
		expect(added.status).toBe(201);

		const res = await suggestions(group._id, admin);

		expect(res.body.suggestions.map((suggestion) => suggestion.catalogItemId)).not.toContain("tamimi-1001");
	});

});
