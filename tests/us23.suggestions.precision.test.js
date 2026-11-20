// AI suggestions — criterion 3: at least 80% of the suggestions were really on the next list.
//
// ml/generate_data.py writes ml/out/criterion3_households.json: ten households the model never trained
// on, each with its first completed trips and the big shop that came next. For every household the test
// seeds that history in its own group, asks for suggestions, adds every suggestion the way the AI
// suggestions tab does, and completes the list. It then compares the suggestions with the shop that
// really happened.
//
// The precision is pooled over all households (suggested items that were bought ÷ suggested items),
// so one unusual household cannot decide the result on its own. A single household with eight
// suggestions fails on its second miss; ten households together leave a real margin.
//
// Run from src/:  npm test -- us23.suggestions.precision

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
const { households } = require("../ml/out/criterion3_households.json");

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const REQUIRED_PRECISION = 0.8;

const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);

let mongo;

const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

const suggestions = (groupId, user) =>
	request(app).get(`/api/groups/${groupId}/suggestions`).set("Authorization", tokenFor(user));

const addItem = (groupId, user, body) =>
	request(app).post(`/api/groups/${groupId}/items`).set("Authorization", tokenFor(user)).send(body);

const setStatus = (groupId, itemId, user) =>
	request(app).patch(`/api/groups/${groupId}/items/${itemId}/status`).set("Authorization", tokenFor(user)).send({ status: "found" });

const complete = (groupId, user) =>
	request(app).post(`/api/groups/${groupId}/complete-list`).set("Authorization", tokenFor(user)).send();


async function setupUsers() {
	return User.insertMany([
		{ handleName: "Sara", phoneNumber: "+966550000001" },
		{ handleName: "Omar", phoneNumber: "+966550000002" },
	]);
}


// one group per household, with the household's completed trips in its item history
async function seedHousehold(household, creator, admin) {
	const group = await Group.create({
		name: household.group,
		createdBy: creator._id,
		members: [
			{ user: creator._id, role: "creator" },
			{ user: admin._id, role: "admin" },
		],
	});

	const now = Date.now();
	const rows = [];

	for (const trip of household.trips) {
		const completed = now - Math.round(trip.daysBeforeNow * DAY_MS);
		const tripId = new mongoose.Types.ObjectId();

		trip.items.forEach((item, offset) => {
			rows.push({
				group: group._id,
				tripId,
				catalogItemId: item.catalogItemId,
				quantity: item.quantity,
				unit: item.unit,
				addedBy: admin._id,
				addedAt: new Date(completed - (trip.items.length - offset) * MINUTE_MS),
				createdAt: new Date(completed),
				status: item.status,
			});
		});
	}

	await ItemHistory.insertMany(rows);

	return group;
}


// the admin asks for suggestions, adds every one of them and completes the list
async function shop(household, group, admin) {
	const response = await suggestions(group._id, admin);

	expect(response.status).toBe(200);
	expect(response.body.code).toBeNull();

	for (const suggestion of response.body.suggestions) {
		const added = await addItem(group._id, admin, {
			catalogItemId: suggestion.catalogItemId,
			quantity: suggestion.suggestedQuantity,
			unit: suggestion.suggestedUnit,
		});

		expect(added.status).toBe(201);
	}

	const onList = await ListItem.find({ group: group._id }).lean();
	expect(onList).toHaveLength(response.body.suggestions.length);

	if (onList.length > 0) {
		for (const item of onList) {
			const marked = await setStatus(group._id, item._id, admin);
			expect(marked.status).toBe(200);
		}

		const completed = await complete(group._id, admin);
		expect(completed.status).toBe(200);

		// the completed list became one more trip in the history, so the next request has more to learn from
		const trips = await ItemHistory.distinct("tripId", { group: group._id, tripId: { $ne: null } });
		expect(trips).toHaveLength(household.trips.length + 1);
	}

	// what the household really bought next
	const bought = new Set(household.nextTrip);
	const suggested = response.body.suggestions.map((suggestion) => suggestion.catalogItemId);

	return { group: household.group, suggested: suggested.length, hits: suggested.filter((id) => bought.has(id)).length };
}


beforeAll(async () => {
	mongo = await MongoMemoryServer.create();
	await mongoose.connect(process.env.TEST_MONGO_URI || mongo.getUri(), { dbName: "suggestions-precision" });
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


test("the fixture holds several held-out households", () => {
	expect(households.length).toBeGreaterThanOrEqual(10);
	expect(new Set(households.map((household) => household.group)).size).toBe(households.length);
});


test("at least 80% of the suggested items were on the next list, over all households", async () => {
	const [creator, admin] = await setupUsers();
	const results = [];

	for (const household of households) {
		const group = await seedHousehold(household, creator, admin);
		results.push(await shop(household, group, admin));
	}

	const suggested = results.reduce((sum, result) => sum + result.suggested, 0);
	const hits = results.reduce((sum, result) => sum + result.hits, 0);

	// most households get suggestions; a household with no confident candidate gets none, which is allowed
	expect(results.filter((result) => result.suggested > 0).length).toBeGreaterThanOrEqual(households.length / 2);
	expect(suggested).toBeGreaterThan(0);

	expect(hits / suggested).toBeGreaterThanOrEqual(REQUIRED_PRECISION);
});
