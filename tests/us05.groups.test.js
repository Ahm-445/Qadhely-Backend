// US 05: Create Shopping List Groups — API tests (Jest + Supertest)
// Run from src/:  npm test
// Uses an in-memory MongoDB. Set TEST_MONGO_URI to use another TEST database instead.

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const contactRoutes = require("../src/routes/contactRoutes");
const User = require("../src/models/User");
const Group = require("../src/models/Group");


// small app with only the US 05 routes (index.js starts a server, so we don't import it)
const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);
app.use("/api/contacts", contactRoutes);


let mongo;

// same token shape as authRoutes.js login
const tokenFor = (user) => `Bearer ${jwt.sign(
	{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
	process.env.JWT_SECRET
)}`;

async function makeUsers(n) {
	const docs = Array.from({ length: n }, (_, i) => ({
		handleName: `user${i}`,
		phoneNumber: `+96655${String(i).padStart(7, "0")}`,
	}));
	return User.insertMany(docs);
}


beforeAll(async () => {
	let uri = process.env.TEST_MONGO_URI;
	if (!uri) {
		mongo = await MongoMemoryServer.create();
		uri = mongo.getUri();
	}
	await mongoose.connect(uri, { dbName: "qadhely_test_us05" });
});

afterAll(async () => {
	await mongoose.connection.dropDatabase().catch(() => {});
	await mongoose.disconnect();
	if (mongo) await mongo.stop();
});

beforeEach(async () => {
	await Promise.all([User.deleteMany({}), Group.deleteMany({})]);
});



describe("POST /api/contacts/match", () => {

	test("returns only registered contacts and not the user themself (SF-17, NFR-09)", async () => {
		const [me, friend] = await makeUsers(2);

		const res = await request(app)
			.post("/api/contacts/match")
			.set("Authorization", tokenFor(me))
			.send({ phones: ["0550000000", "055 000 0001", "0599999999", "+1 415 555 0100"] });
			// me, friend (with spaces), not registered, not Saudi

		expect(res.status).toBe(200);
		expect(res.body.users).toHaveLength(1);
		expect(res.body.users[0]).toMatchObject({ id: String(friend._id), handleName: "user1" });
	});

	test("rejects a missing token", async () => {
		const res = await request(app).post("/api/contacts/match").send({ phones: [] });
		expect(res.status).toBe(401);
	});

});



describe("POST /api/groups", () => {

	test("AC-02: creates a group with 0 members and makes the user Group Creator", async () => {
		const [me] = await makeUsers(1);

		const res = await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "  Family groceries  " });

		expect(res.status).toBe(201);
		expect(res.body.group).toMatchObject({ name: "Family groceries", myRole: "creator", memberCount: 1 });

		const saved = await Group.findById(res.body.group.id);
		expect(String(saved.createdBy)).toBe(String(me._id));
		expect(Group.isAdminRole(saved.roleOf(me._id))).toBe(true); // SF-19
	});

	test("AC-02: adds the selected registered users as members", async () => {
		const [me, a, b] = await makeUsers(3);

		const res = await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "Home", memberIds: [String(a._id), String(b._id)] });

		expect(res.status).toBe(201);
		const saved = await Group.findById(res.body.group.id);
		expect(saved.members).toHaveLength(3);
		expect(saved.roleOf(a._id)).toBe("member");
		expect(saved.roleOf(b._id)).toBe("member");
	});

	test("SF-18: two groups with the same name get different ids", async () => {
		const [me] = await makeUsers(1);
		const r1 = await request(app).post("/api/groups").set("Authorization", tokenFor(me)).send({ name: "Home" });
		const r2 = await request(app).post("/api/groups").set("Authorization", tokenFor(me)).send({ name: "Home" });
		expect(r1.body.group.id).not.toBe(r2.body.group.id);
	});

	test("ignores duplicate ids and the creator's own id", async () => {
		const [me, a] = await makeUsers(2);

		const res = await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "Home", memberIds: [String(a._id), String(a._id), String(me._id)] });

		expect(res.status).toBe(201);
		expect(res.body.group.memberCount).toBe(2);
	});

	test("allows exactly 10 members", async () => {
		const [me, ...others] = await makeUsers(11);

		const res = await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "Big family", memberIds: others.map((u) => String(u._id)) });

		expect(res.status).toBe(201);
		expect(res.body.group.memberCount).toBe(11);
	});

	test("rejects more than 10 members", async () => {
		const [me, ...others] = await makeUsers(12);

		const res = await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "Too big", memberIds: others.map((u) => String(u._id)) });

		expect(res.status).toBe(400);
		expect(await Group.countDocuments()).toBe(0);
	});

	test.each([[undefined], [""], ["   "], ["x".repeat(51)], [123]])("rejects invalid name %p", async (name) => {
		const [me] = await makeUsers(1);
		const res = await request(app).post("/api/groups").set("Authorization", tokenFor(me)).send({ name });
		expect(res.status).toBe(400);
		expect(res.body.error).toBeDefined();
	});

	test("rejects unregistered or malformed member ids", async () => {
		const [me] = await makeUsers(1);
		const ghost = new mongoose.Types.ObjectId().toString();

		const r1 = await request(app).post("/api/groups").set("Authorization", tokenFor(me)).send({ name: "A", memberIds: [ghost] });
		const r2 = await request(app).post("/api/groups").set("Authorization", tokenFor(me)).send({ name: "A", memberIds: ["nope"] });

		expect(r1.status).toBe(400);
		expect(r2.status).toBe(400);
		expect(await Group.countDocuments()).toBe(0);
	});

	test("rejects a missing or invalid token", async () => {
		const r1 = await request(app).post("/api/groups").send({ name: "Home" });
		const r2 = await request(app).post("/api/groups").set("Authorization", "Bearer bad").send({ name: "Home" });
		expect(r1.status).toBe(401);
		expect(r2.status).toBe(401);
	});

});



describe("GET /api/groups", () => {

	test("AC-03: new group is under 'created' for the creator and 'shared' for members", async () => {
		const [me, a, outsider] = await makeUsers(3);

		await request(app)
			.post("/api/groups")
			.set("Authorization", tokenFor(me))
			.send({ name: "Home", memberIds: [String(a._id)] });

		const mine = await request(app).get("/api/groups").set("Authorization", tokenFor(me));
		expect(mine.status).toBe(200);
		expect(mine.body.created.map((g) => g.name)).toEqual(["Home"]);
		expect(mine.body.shared).toEqual([]);

		const theirs = await request(app).get("/api/groups").set("Authorization", tokenFor(a));
		expect(theirs.body.created).toEqual([]);
		expect(theirs.body.shared[0]).toMatchObject({ name: "Home", myRole: "member" });

		const none = await request(app).get("/api/groups").set("Authorization", tokenFor(outsider));
		expect(none.body).toEqual({ created: [], shared: [] });
	});

});
describe("POST /api/groups/:groupId/members — US 06", () => {
  test("admin can add a registered user to an existing group", async () => {
    const [admin, friend] = await makeUsers(2);

    const created = await request(app)
      .post("/api/groups")
      .set("Authorization", tokenFor(admin))
      .send({ name: "Family" });

    const res = await request(app)
      .post(`/api/groups/${created.body.group.id}/members`)
      .set("Authorization", tokenFor(admin))
      .send({ userId: String(friend._id) });

    expect(res.status).toBe(200);
    expect(res.body.group.memberCount).toBe(2);

    const saved = await Group.findById(created.body.group.id);
    expect(saved.roleOf(friend._id)).toBe("member");
  });
  test("regular member cannot add another user", async () => {
  const [admin, member, friend] = await makeUsers(3);

  const created = await request(app)
    .post("/api/groups")
    .set("Authorization", tokenFor(admin))
    .send({ name: "Family", memberIds: [String(member._id)] });

  const res = await request(app)
    .post(`/api/groups/${created.body.group.id}/members`)
    .set("Authorization", tokenFor(member))
    .send({ userId: String(friend._id) });

  expect(res.status).toBe(403);
});

test("cannot add an unregistered user", async () => {
  const [admin] = await makeUsers(1);

  const created = await request(app)
    .post("/api/groups")
    .set("Authorization", tokenFor(admin))
    .send({ name: "Family" });

  const fakeUserId = new (require("mongoose").Types.ObjectId)();

  const res = await request(app)
    .post(`/api/groups/${created.body.group.id}/members`)
    .set("Authorization", tokenFor(admin))
    .send({ userId: String(fakeUserId) });

  expect(res.status).toBe(400);
  expect(res.body.error).toBe(
    "This contact is not registered with Qadhely."
  );
});

test("admin can generate a group invite link", async () => {
  const [admin] = await makeUsers(1);

  const created = await request(app)
    .post("/api/groups")
    .set("Authorization", tokenFor(admin))
    .send({ name: "Family" });

  const res = await request(app)
    .post(`/api/groups/${created.body.group.id}/invite`)
    .set("Authorization", tokenFor(admin));

  expect(res.status).toBe(200);
  expect(res.body.inviteLink).toMatch(
    /^\/api\/groups\/join\/[a-f0-9]{48}$/
  );
});
test("registered user can join a group with an invite link", async () => {
  const [admin, invitee] = await makeUsers(2);

  const created = await request(app)
    .post("/api/groups")
    .set("Authorization", tokenFor(admin))
    .send({ name: "Family" });

  const invite = await request(app)
    .post(`/api/groups/${created.body.group.id}/invite`)
    .set("Authorization", tokenFor(admin));

  const token = invite.body.inviteLink.split("/").pop();

  const joined = await request(app)
    .post(`/api/groups/join/${token}`)
    .set("Authorization", tokenFor(invitee));

  expect(joined.status).toBe(200);
  expect(joined.body.message).toBe("Joined group successfully.");
  expect(joined.body.group.memberCount).toBe(2);

  const saved = await Group.findById(created.body.group.id);
  expect(saved.roleOf(invitee._id)).toBe("member");
});
test("cannot join a group with an invalid invite link", async () => {
  const [invitee] = await makeUsers(1);

  const res = await request(app)
    .post("/api/groups/join/invalid-token")
    .set("Authorization", tokenFor(invitee));

  expect(res.status).toBe(404);
  expect(res.body.error).toBe("Invalid or expired invite link.");
});


});
