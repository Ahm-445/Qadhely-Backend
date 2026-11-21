
// US 17: Item Not Found Notification — tests

process.env.JWT_SECRET = "test-secret";

const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const groupRoutes = require("../src/routes/groupRoutes");
const User = require("../src/models/User");
const Group = require("../src/models/Group");
const ListItem = require("../src/models/ListItem");

const {
        whenNotificationsIdle,
        NOTIFICATION_TYPES,
} = require("../src/services/pushNotifications");

const app = express();
app.use(express.json());
app.use("/api/groups", groupRoutes);

const realFetch = global.fetch;

let mongo;
let fetchMock;
let phoneCounter = 0;

const tokenFor = (user) => `Bearer ${jwt.sign(
        { id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
        process.env.JWT_SECRET
)}`;

const tok = (n) => `ExponentPushToken[${String(n).padStart(22, "0")}]`;

async function makeUser(handleName, pushTokens = []) {
        phoneCounter += 1;
        return User.create({
                handleName,
                phoneNumber: `+96655${String(phoneCounter).padStart(7, "0")}`,
                pushTokens,
        });
}

async function setup() {
        const creator = await makeUser("Sara", [tok(1)]);
        const admin = await makeUser("Omar", [tok(2)]);
        const member = await makeUser("Ali", [tok(3)]);
        const outsider = await makeUser("Noura", [tok(4)]);

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

async function makeItem(group, user) {
        return ListItem.create({
                group: group._id,
                catalogItemId: "tamimi-1196",
                customName: "Fresh milk",
                quantity: 1,
                unit: "piece",
                addedBy: user._id,
        });
}

const setStatus = (group, item, user, body) =>
        request(app)
                .patch(`/api/groups/${group._id}/items/${item._id}/status`)
                .set("Authorization", tokenFor(user))
                .send(body);

const acceptAll = async (url, options) => {
        const messages = JSON.parse(options.body);
        return {
                ok: true,
                status: 200,
                json: async () => ({
                        data: messages.map(() => ({ status: "ok", id: "ticket" })),
                }),
        };
};

const allMessages = () =>
        fetchMock.mock.calls.flatMap(([, options]) => JSON.parse(options.body));

const itemNotFoundMessages = () =>
        allMessages().filter((m) => m.data.type === NOTIFICATION_TYPES.ITEM_NOT_FOUND);

const mark = async (group, item, user, body) => {
        const res = await setStatus(group, item, user, body);
        await whenNotificationsIdle();
        return res;
};

beforeAll(async () => {
        mongo = await MongoMemoryServer.create();
        await mongoose.connect(mongo.getUri(), { dbName: "qadhely_test_us17" });
        await Promise.all([User.init(), Group.init(), ListItem.init()]);
});

afterAll(async () => {
        global.fetch = realFetch;
        await mongoose.connection.dropDatabase().catch(() => {});
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
});

beforeEach(async () => {
        await Promise.all([
                User.deleteMany({}),
                Group.deleteMany({}),
                ListItem.deleteMany({}),
        ]);

        fetchMock = jest.fn(acceptAll);
        global.fetch = fetchMock;
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
        jest.restoreAllMocks();
});

describe("US 17 — Item Not Found Notification", () => {

        test("creator and admins receive the notification, regular members do not", async () => {
                const { creator, member, group } = await setup();
                const item = await makeItem(group, creator);

                await mark(group, item, member, { status: "notFound" });

                expect(itemNotFoundMessages().map((m) => m.to).sort()).toEqual([
                        tok(1), tok(2),
                ]);
        });

        test("notification contains the item name and replacement recommendation", async () => {
                const { creator, member, group } = await setup();
                const item = await makeItem(group, creator);

                await mark(group, item, member, {
                        status: "notFound",
                        replacementText: "Low fat milk",
                });

                expect(itemNotFoundMessages()[0]).toMatchObject({
                        title: "Item not found",
                        body: "Fresh milk was marked as not found.",
                        data: {
                                type: "item_not_found",
                                groupId: String(group._id),
                                itemId: String(item._id),
                                itemName: "Fresh milk",
                                replacementText: "Low fat milk",
                        },
                        sound: "default",
                        channelId: "default",
                        priority: "high",
                });
        });

        test("notification type is exported", () => {
                expect(NOTIFICATION_TYPES.ITEM_NOT_FOUND).toBe("item_not_found");
        });

        test("the status update succeeds even if Expo is unavailable", async () => {
                const { creator, member, group } = await setup();
                const item = await makeItem(group, creator);

                fetchMock.mockImplementation(async () => {
                        throw new Error("network down");
                });

                const res = await mark(group, item, member, {
                        status: "notFound",
                });

                expect(res.status).toBe(200);
                expect((await ListItem.findById(item._id).lean()).status).toBe("notFound");
        });

});
