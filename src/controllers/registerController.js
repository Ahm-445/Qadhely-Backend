const User = require("../models/User");

const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone");
const { sendWhatsAppOtp } = require("../services/authentica");

// SF-04: an OTP is valid for 60 seconds. Used by the client for the countdown (SF-05).
const OTP_EXPIRES_IN_SECONDS = 60;


// US 01 registration, step 1 (AC-01, AC-02): reject registered phone numbers, otherwise
// send an OTP via WhatsApp. The user is created only after OTP verification (AC-03).
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

		// AC-01: send the OTP via WhatsApp
		const sent = await sendWhatsAppOtp(phoneNumber);

		if (!sent) {
			return res.status(502).json({ error: "Could not send the verification code. Please try again." });
		}

		return res.status(200).json({ sent: true, expiresInSeconds: OTP_EXPIRES_IN_SECONDS });

	}
	catch (err) {
		next(err);
	}

}


module.exports = { register };
