const User = require("../models/User");
const Group = require("../models/Group");
const ListItem = require("../models/ListItem");


// Expo push service. The app registers "ExponentPushToken[...]" tokens through POST /api/devices
// (see devicesController), and they live in User.pushTokens.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_MAX = 100; // Expo accepts at most 100 messages per request
const EXPO_TIMEOUT_MS = 10000;

// the Android channel the app creates (services/pushNotifications.ts in the app)
const ANDROID_CHANNEL_ID = "default";

// US 21: the roles that get "list completed" (the Group Creator has admin privileges)
const ADMIN_ROLES = [Group.ROLES.CREATOR, Group.ROLES.ADMIN];
const { ITEM_STATUSES } = ListItem;

// only well-formed Expo tokens are sent to; anything else would just come back as an error
const EXPO_TOKEN_PATTERN = /^(Exponent|Expo)PushToken\[.+\]$/;

// US 18: members are told about new items only if more than this long has passed
// since the previous item was added to the same group
const ITEMS_ADDED_WINDOW_MS = 5 * 60 * 1000;

const NOTIFICATION_TYPES = Object.freeze({
        ITEMS_ADDED: "items_added",
        LIST_COMPLETED: "list_completed",
        ITEM_NOT_FOUND: "item_not_found",
});

// US 21: a replacement is created a moment after the item it replaces is marked "replaced". Within
// this long, a replaced item whose replacement is not there yet counts as still open.
const REPLACEMENT_GRACE_MS = 30 * 1000;


// Notification jobs run after the request that started them has been answered. They are tracked
// so that a test (or a graceful shutdown) can wait until every one of them has finished.
const pendingJobs = new Set();

function track(job) {
	pendingJobs.add(job);

	const done = () => pendingJobs.delete(job);
	job.then(done, done);

	return job;
}

async function whenNotificationsIdle() {
	while (pendingJobs.size > 0) {
		await Promise.allSettled([...pendingJobs]);
	}
}


// Sends messages to Expo in batches of 100 and returns the tokens Expo says are no longer valid.
// A batch that fails (network, timeout, HTTP error, unreadable answer) is logged and skipped:
// the other batches are still sent, and nothing here throws.
async function sendToExpo(messages) {

	const deadTokens = new Set();

	for (let start = 0; start < messages.length; start += EXPO_BATCH_MAX) {

		const batch = messages.slice(start, start + EXPO_BATCH_MAX);

		try {

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), EXPO_TIMEOUT_MS);

			let response;

			try {
				response = await fetch(EXPO_PUSH_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(batch),
					signal: controller.signal,
				});
			}
			finally {
				clearTimeout(timer);
			}

			const body = await response.json().catch(() => null);

			if (!response.ok) {
				console.error("Expo push request failed:", response.status);
				continue;
			}

			// tickets come back in the same order as the messages of the batch
			const tickets = Array.isArray(body?.data) ? body.data : [];

			tickets.forEach((ticket, index) => {

				if (ticket?.status !== "error") return;

				if (ticket.details?.error === "DeviceNotRegistered" && batch[index]) {
					deadTokens.add(batch[index].to);
				}
				else {
					console.error("Expo push ticket error:", ticket.details?.error || ticket.message || "unknown");
				}
			});

		}
		catch (err) {
			console.error("Expo push batch failed:", err.message);
		}
	}

	return [...deadTokens];
}


/**
 * Sends one push message to every registered device of every member of the group except the
 * person who made the change (actorId).
 *
 * `data` is what travels with the notification (the app reads it when the notification is
 * tapped). Pass a function to build it per recipient from the member ({ user, role }).
 * `roles` (optional) limits the recipients to members with one of those roles; by default every
 * member is a recipient.
 *
 * Tokens are deduplicated, and tokens Expo reports as DeviceNotRegistered are removed from the
 * users who held them. Never throws: a failed notification must not fail the request behind it.
 * `group` is a plain object: { name, members: [{ user, role }] }.
 */
async function notifyGroupMembers(group, actorId, { title, body, data, roles }) {

	try {

		const recipients = (group.members || []).filter((member) =>
			String(member.user) !== String(actorId) && (!roles || roles.includes(member.role))
		);

		if (recipients.length === 0) return { messages: 0, deadTokens: 0 };

		const users = await User.find({ _id: { $in: recipients.map((member) => member.user) } })
			.select("pushTokens")
			.lean();

		const tokensByUser = new Map(users.map((user) => [String(user._id), user.pushTokens || []]));

		const seen = new Set();
		const messages = [];

		for (const member of recipients) {

			for (const token of tokensByUser.get(String(member.user)) || []) {

				if (typeof token !== "string" || !EXPO_TOKEN_PATTERN.test(token) || seen.has(token)) continue;

				seen.add(token);

				messages.push({
					to: token,
					title,
					body,
					data: typeof data === "function" ? data(member) : data,
					sound: "default",
					channelId: ANDROID_CHANNEL_ID,
					priority: "high",
				});
			}
		}

		if (messages.length === 0) return { messages: 0, deadTokens: 0 };

		const deadTokens = await sendToExpo(messages);

		// the app was uninstalled or the token expired: stop sending to it
		if (deadTokens.length > 0) {
			await User.updateMany(
				{ pushTokens: { $in: deadTokens } },
				{ $pull: { pushTokens: { $in: deadTokens } } }
			);
		}

		return { messages: messages.length, deadTokens: deadTokens.length };

	}
	catch (err) {
		console.error("Failed to send group notification:", err.message);
		return { messages: 0, deadTokens: 0, failed: true };
	}
}


/**
 * US 18 AC-01: "more than 5 minutes since the last addition". The very first addition always
 * qualifies, and exactly 5 minutes does not.
 */
function isItemsAddedNotificationDue(previousAddedAt, now) {

	if (!previousAddedAt) return true;

	const previous = new Date(previousAddedAt).getTime();

	if (Number.isNaN(previous)) return true;

	return now.getTime() - previous > ITEMS_ADDED_WINDOW_MS;
}


async function runItemsAdded(groupId, actorId, now) {

	try {

		// One atomic step records this addition AND returns the group as it was just before it, so
		// the previous timestamp decides eligibility. MongoDB applies updates to a single document
		// one at a time: of several additions at once, only the first sees an old timestamp, and
		// every other one sees the timestamp the first just wrote. $max keeps the timestamp from
		// ever moving backwards. updatedAt is left alone: an addition is not an edit of the group.
		const group = await Group.findOneAndUpdate(
			{ _id: groupId },
			{ $max: { lastItemAddedAt: now } },
			{ returnDocument: "before", projection: "name members lastItemAddedAt", lean: true, timestamps: false }
		);

		if (!group) return { eligible: false, messages: 0, deadTokens: 0 };

		if (!isItemsAddedNotificationDue(group.lastItemAddedAt, now)) {
			return { eligible: false, messages: 0, deadTokens: 0 };
		}

		const memberCount = group.members.length;

		const result = await notifyGroupMembers(group, actorId, {
			title: group.name,
			body: "New items were added to the shopping list.",
			// US 18 AC-02: what the app needs to open this group for this recipient
			data: (member) => ({
				type: NOTIFICATION_TYPES.ITEMS_ADDED,
				groupId: String(group._id),
				groupName: group.name,
				myRole: member.role,
				memberCount,
			}),
		});

		return { eligible: true, ...result };

	}
	catch (err) {
		console.error("Failed to process the items-added notification:", err.message);
		return { eligible: false, messages: 0, deadTokens: 0, failed: true };
	}
}


/**
 * US 18: call this after an item has been saved to the group's list. It decides whether the
 * other members are due a notification, and sends it. Never rejects and never throws, so the
 * caller can start it without waiting for it. `now` is only for tests.
 */
function notifyItemsAdded(groupId, actorId, now = new Date()) {
	return track(runItemsAdded(groupId, actorId, now));
}


/**
 * US 21: the list is complete when it has at least one found item and every item is either found
 * or replaced (a replaced item is resolved; its replacement is an item of its own and has to be
 * found too). Pending, not-found and old status-less items keep it open, and so does an empty list.
 */
async function isListComplete(groupId, now = new Date()) {

	const items = await ListItem.find({ group: groupId }).select("status replacedBy statusUpdatedAt").lean();
	const ids = new Set(items.map((item) => String(item._id)));

	let found = 0;

	for (const item of items) {

		if (item.status === ITEM_STATUSES.FOUND) {
			found += 1;
			continue;
		}

		if (item.status !== ITEM_STATUSES.REPLACED) return false;

		// replaced a moment ago and the replacement has not been saved yet: not resolved
		const replacementMissing = !item.replacedBy || !ids.has(String(item.replacedBy));
		const recent = !item.statusUpdatedAt || now.getTime() - new Date(item.statusUpdatedAt).getTime() < REPLACEMENT_GRACE_MS;

		if (replacementMissing && recent) return false;
	}

	return found > 0;
}


/**
 * US 21: the list is no longer complete (an item was added, replaced or marked again), so the next
 * completion may notify again. Call it after the change has been saved. Never throws.
 */
async function resetListCompleted(groupId) {

	try {
		await Group.updateOne(
			{ _id: groupId, listCompletedNotifiedAt: { $ne: null } },
			{ $set: { listCompletedNotifiedAt: null } },
			{ timestamps: false }
		);
	}
	catch (err) {
		console.error("Failed to reset the list-completed marker:", err.message);
	}
}


async function runListCompleted(groupId, now) {

	let claimed = false;

	try {

		if (!(await isListComplete(groupId, now))) return { eligible: false, messages: 0, deadTokens: 0 };

		// One atomic step claims this completion: of several final marks at once only one finds the
		// marker empty. The marker is cleared again by every change that reopens the list.
		const group = await Group.findOneAndUpdate(
			{ _id: groupId, listCompletedNotifiedAt: null },
			{ $set: { listCompletedNotifiedAt: now } },
			{ returnDocument: "after", projection: "name members", lean: true, timestamps: false }
		);

		if (!group) return { eligible: false, messages: 0, deadTokens: 0 };

		claimed = true;

		// a change that reopened the list between the first check and the claim may have cleared the
		// marker before we set it: look again, and give the claim back if the list is open
		if (!(await isListComplete(groupId, now))) {
			await Group.updateOne({ _id: groupId, listCompletedNotifiedAt: now }, { $set: { listCompletedNotifiedAt: null } }, { timestamps: false });
			return { eligible: false, messages: 0, deadTokens: 0 };
		}

		const memberCount = group.members.length;

		const result = await notifyGroupMembers(group, null, {
			title: group.name,
			body: "The shopping list is completed.",
			roles: ADMIN_ROLES,
			data: (member) => ({
				type: NOTIFICATION_TYPES.LIST_COMPLETED,
				groupId: String(group._id),
				groupName: group.name,
				myRole: member.role,
				memberCount,
			}),
		});

		return { eligible: true, ...result };

	}
	catch (err) {
		console.error("Failed to process the list-completed notification:", err.message);

		if (claimed) {
			await Group.updateOne({ _id: groupId, listCompletedNotifiedAt: now }, { $set: { listCompletedNotifiedAt: null } }, { timestamps: false }).catch(() => {});
		}

		return { eligible: false, messages: 0, deadTokens: 0, failed: true };
	}
}


/**
 * US 21: call this after an item has been marked found. If that completed the list, the group's
 * creator and admins (the person who marked it included) are told once. Never rejects, so the
 * caller can start it without waiting. `now` is only for tests.
 */
function notifyListCompleted(groupId, now = new Date()) {
	return track(runListCompleted(groupId, now));
}

// US 17: notify group creators and admins when an item is marked not found.
async function runItemNotFound(groupId, itemId, itemName, replacementText) {
        try {
                const group = await Group.findById(groupId)
                        .select("name members")
                        .lean();

                if (!group) return { messages: 0, deadTokens: 0 };

                return await notifyGroupMembers(group, null, {
                        title: "Item not found",
                        body: `${itemName} was marked as not found.`,
                        roles: ADMIN_ROLES,
                        data: {
                                type: NOTIFICATION_TYPES.ITEM_NOT_FOUND,
                                groupId: String(groupId),
                                itemId: String(itemId),
                                itemName,
                                replacementText: replacementText || null,
                        },
                });
        }
        catch (err) {
                console.error("Failed to send item-not-found notification:", err.message);
                return { messages: 0, deadTokens: 0, failed: true };
        }
}

function notifyItemNotFound(groupId, itemId, itemName, replacementText = null) {
        return track(runItemNotFound(groupId, itemId, itemName, replacementText));
}

module.exports = {
	notifyItemsAdded,
	notifyListCompleted,
	notifyItemNotFound,
	resetListCompleted,
	isListComplete,
	notifyGroupMembers,
	isItemsAddedNotificationDue,
	whenNotificationsIdle,
	NOTIFICATION_TYPES,
	ITEMS_ADDED_WINDOW_MS,
	EXPO_PUSH_URL,
	EXPO_BATCH_MAX,
};
