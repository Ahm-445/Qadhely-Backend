const User = require("../models/User");

const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone");


// US 01 registration. AC-02 only: reject phone numbers that are already registered.
// Creating the user and sending the OTP (AC-01, AC-03) are not implemented yet.
const register = async (req, res, next) => {

	try {

		const handleName = typeof req.body.handleName === "string" ? req.body.handleName.trim() : "";
		const phoneNumber = normalizeSaudiPhone(req.body.phoneNumber);

		if (!handleName) {
			return res.status(400).json({ error: "Handle name is required." });
		}

		if (!phoneNumber) {
			return res.status(400).json({ error: "Enter a valid Saudi mobile number." });
		}

		// AC-02: phone number already registered
		const existing = await User.findOne({ phoneNumber });

		if (existing) {
			return res.status(409).json({ error: "This phone number is already registered." });
		}

		// AC-01 (send OTP) is not implemented yet
		return res.status(501).json({ error: "Registration is not implemented yet." });

	}
	catch (err) {
		next(err);
	}

}


module.exports = { register };
