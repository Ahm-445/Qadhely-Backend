const mongoose = require("mongoose");


// Counts OTP requests per phone number per hour (NFR-01). Kept separate from
// RegistrationOtp so expiring or deleting OTP records can never reset the limit.
const otpRequestLogSchema = new mongoose.Schema({

	phoneNumber: {
		type: String,
		required: true,
		unique: true
	},

	windowStart: { type: Date, required: true },

	count: { type: Number, required: true },

	// cleanup only: a window lasts 1 hour, so a log idle for 2 hours is always expired
	lastRequestAt: { type: Date, required: true, index: { expireAfterSeconds: 2 * 60 * 60 } },

});


module.exports = mongoose.model("OtpRequestLog", otpRequestLogSchema);
