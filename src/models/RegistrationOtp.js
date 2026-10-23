const mongoose = require("mongoose");


// A pending registration waiting for OTP verification (US 01). One per phone number.
// The OTP itself is generated and held by Authentica; we only track its lifecycle.
// The user is created only after the OTP is verified.
const registrationOtpSchema = new mongoose.Schema({

	phoneNumber: {
		type: String,
		required: true,
		unique: true
	},

	handleName: {
		type: String,
		required: true,
		trim: true
	},

	sentAt: { type: Date, required: true },

	// application-enforced expiry (60s); never rely on the TTL index below for this
	expiresAt: { type: Date, required: true },

	failedAttempts: { type: Number, default: 0 },

	status: {
		type: String,
		enum: ["pending", "consumed", "invalidated"],
		default: "pending"
	},

	// cleanup only: MongoDB removes the document after this date
	purgeAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },

});


module.exports = mongoose.model("RegistrationOtp", registrationOtpSchema);
