const User = require("../models/User");
const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone");

const MAX_PHONES = 2000;


// POST /api/contacts/match
// body: { phones: ["0551234567", "+966 55 123 4567", ...] }
// Returns only the phone contacts that are registered Qadhely users (SF-17).
// NFR-09: the numbers are used only for this lookup and are never saved.
const matchContacts = async (req, res) => {
	try {

		const { phones } = req.body || {};

		if (!Array.isArray(phones)) {
			return res.status(400).json({ error: "phones must be a list." });
		}

		if (phones.length > MAX_PHONES) {
			return res.status(400).json({ error: `Too many contacts (max ${MAX_PHONES}).` });
		}

		// non-Saudi or invalid numbers are skipped
		const normalized = [...new Set(phones.map(normalizeSaudiPhone).filter(Boolean))];

		if (normalized.length === 0) {
			return res.status(200).json({ users: [] });
		}

		const users = await User.find({
			phoneNumber: { $in: normalized },
			_id: { $ne: req.user.id }, // don't list the user themself
		})
			.select("_id handleName phoneNumber")
			.sort({ handleName: 1 })
			.lean();

		return res.status(200).json({
			users: users.map((u) => ({
				id: String(u._id),
				handleName: u.handleName,
				phoneNumber: u.phoneNumber,
			})),
		});

	}
	catch (err) {
		console.log(err);
		res.status(500).json({ error: "Failed to check contacts" });
	}
};


module.exports = { matchContacts };
