const User = require("../models/User");


// tokens are opaque strings from the push service; 255 chars is well above any real token
const PUSH_TOKEN_MAX = 255;


// POST /api/devices
// body: { pushToken: string }
// Links the phone's push token to the logged-in user, so notifications can reach it.
const addDeviceToken = async (req, res) => {

	try {

		const raw = req.body?.pushToken;
		const pushToken = typeof raw === "string" ? raw.trim() : "";

		if (!pushToken || pushToken.length > PUSH_TOKEN_MAX) {
			return res.status(400).json({ error: "A valid push token is required." });
		}

		// the phone belongs to whoever is logged in now, so the same token is
		// removed from any other account before it is linked to this one
		await User.updateMany(
			{ _id: { $ne: req.user.id }, pushTokens: pushToken },
			{ $pull: { pushTokens: pushToken } }
		);

		// $addToSet keeps the list free of duplicates when the app registers again
		const result = await User.updateOne(
			{ _id: req.user.id },
			{ $addToSet: { pushTokens: pushToken } }
		);

		if (result.matchedCount === 0) {
			return res.status(404).json({ error: "User not found." });
		}

		res.status(200).json({ linked: true });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to link the device" });
	}

}


// DELETE /api/devices/:pushToken
// Called when the user logs out: the phone's push token is unlinked from the user,
// so no notification is sent to that phone afterwards.
const removeDeviceToken = async (req, res) => {

	try {

		// the token is a path segment, so the app sends it URL-encoded
		// (Expo tokens look like "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")
		const pushToken = (req.params.pushToken || "").trim();

		if (!pushToken) {
			return res.status(400).json({ error: "A push token is required." });
		}

		// only the logged-in user's own token is removed
		const result = await User.updateOne(
			{ _id: req.user.id },
			{ $pull: { pushTokens: pushToken } }
		);

		if (result.matchedCount === 0) {
			return res.status(404).json({ error: "User not found." });
		}

		// a token that was not linked is not an error: logging out twice must not fail
		res.status(200).json({ unlinked: true });

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to unlink the device" });
	}

}


module.exports = {addDeviceToken, removeDeviceToken}
