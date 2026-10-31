const User = require("../models/User");


// Expo push service: the app registers "ExponentPushToken[...]" tokens (see devicesController)
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_MAX = 100; // Expo accepts at most 100 messages per request

const NOTIFICATION_TYPES = Object.freeze({
	ITEM_REMOVED: "item_removed",
	ITEM_MODIFIED: "item_modified",
});


// sends messages to Expo; returns the list of tokens Expo says are no longer valid
async function sendToExpo(messages) {

	const deadTokens = [];

	for (let i = 0; i < messages.length; i += EXPO_BATCH_MAX) {

		const batch = messages.slice(i, i + EXPO_BATCH_MAX);

		const res = await fetch(EXPO_PUSH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(batch),
		});

		const body = await res.json().catch(() => ({}));

		if (!res.ok) {
			console.error("Expo push failed:", res.status, body);
			continue;
		}

		// tickets come back in the same order as the messages
		(body.data || []).forEach((ticket, j) => {
			if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
				deadTokens.push(batch[j].to);
			}
		});
	}

	return deadTokens;
}


// Sends a push notification to every member of the group except the one who made the change.
// `data` travels with the notification so the app can open the right group when it is tapped.
// Never throws: a failed notification must not fail the request that triggered it.
async function notifyGroupMembers(group, actorId, { title, body, data }) {

	try {

		const recipientIds = group.members
			.map((m) => String(m.user))
			.filter((id) => id !== String(actorId));

		if (recipientIds.length === 0) return;

		const users = await User.find({ _id: { $in: recipientIds } }).select("pushTokens").lean();

		const tokens = [...new Set(users.flatMap((u) => u.pushTokens || []))];

		if (tokens.length === 0) return;

		const messages = tokens.map((to) => ({ to, title, body, data, sound: "default" }));

		const deadTokens = await sendToExpo(messages);

		// the app was uninstalled or the token expired: stop sending to it
		if (deadTokens.length > 0) {
			await User.updateMany(
				{ pushTokens: { $in: deadTokens } },
				{ $pull: { pushTokens: { $in: deadTokens } } }
			);
		}

	}
	catch (err) {
		console.error("Failed to send group notification:", err);
	}

}


// US: "item removed" — names the exact item (AC-01) and carries the group id (AC-02)
function notifyItemRemoved(group, actorId, item) {
	return notifyGroupMembers(group, actorId, {
		title: group.name,
		body: `"${item.name}" was removed from the list.`,
		data: {
			type: NOTIFICATION_TYPES.ITEM_REMOVED,
			groupId: String(group._id),
			groupName: group.name,
			itemId: String(item._id),
			itemName: item.name,
		},
	});
}


// US: "item modified" (quantity or unit) — names the exact item (AC-01) and carries the group id (AC-02)
function notifyItemModified(group, actorId, item, previous) {
	return notifyGroupMembers(group, actorId, {
		title: group.name,
		body: `"${item.name}" was changed from ${previous.quantity} ${previous.unit} to ${item.quantity} ${item.unit}.`,
		data: {
			type: NOTIFICATION_TYPES.ITEM_MODIFIED,
			groupId: String(group._id),
			groupName: group.name,
			itemId: String(item._id),
			itemName: item.name,
			quantity: item.quantity,
			unit: item.unit,
		},
	});
}


module.exports = { notifyItemRemoved, notifyItemModified, notifyGroupMembers, NOTIFICATION_TYPES, EXPO_PUSH_URL };
