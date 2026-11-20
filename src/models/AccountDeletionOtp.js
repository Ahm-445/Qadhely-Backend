const mongoose = require("mongoose");


// US 04 — a pending account deletion waiting for OTP verification. One per user.
// Like RegistrationOtp, the code itself is generated and held by Authentica;
// we only track its lifecycle (60-second expiry, attempts, single use).
const accountDeletionOtpSchema = new mongoose.Schema({

	user: {
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
		required: true,
		unique: true
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


module.exports = mongoose.models.AccountDeletionOtp || mongoose.model("AccountDeletionOtp", accountDeletionOtpSchema);
