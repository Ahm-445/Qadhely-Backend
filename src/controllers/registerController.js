const jwt = require("jsonwebtoken");

const User = require("../models/User");
const RegistrationOtp = require("../models/RegistrationOtp");
const OtpRequestLog = require("../models/OtpRequestLog");

const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone");
const { sendWhatsAppOtp, verifyOtp } = require("../services/authentica");


// SF-04: an OTP is valid for 60 seconds. Used by the client for the countdown (SF-05).
const OTP_EXPIRES_IN_SECONDS = 60;

// NFR-01
const MAX_FAILED_ATTEMPTS = 5;
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

// cleanup horizon for pending registrations (expiry itself is checked in code)
const PURGE_AFTER_MS = 10 * 60 * 1000;


const serverError = (res, err) => {
	console.error("[register] unexpected error:", err.name, err.message);
	return res.status(500).json({ error: "Something went wrong. Please try again." });
};


// Two concurrent upserts on a unique key can make one of them fail with a duplicate-key
// error even though the document now exists; running it again then updates normally.
async function retryOnDuplicateKey(fn) {
	try {
		return await fn();
	}
	catch (err) {
		if (err && err.code === 11000) return fn();
		throw err;
	}
}


// Atomically counts one OTP request for the phone in a fixed 1-hour window.
// A request that goes over the limit takes its own increment back, so the stored count
// only reflects requests that were allowed (and can still be refunded).
// Resolves to { allowed, windowStart, retryAfterSeconds }.
async function reserveOtpRequest(phoneNumber, now) {

	const cutoff = new Date(now.getTime() - REQUEST_WINDOW_MS);
	const expired = { $lte: ["$windowStart", cutoff] };

	const log = await retryOnDuplicateKey(() => OtpRequestLog.findOneAndUpdate(
		{ phoneNumber },
		[{
			$set: {
				windowStart: { $cond: [expired, now, "$windowStart"] },
				count: { $cond: [expired, 1, { $add: ["$count", 1] }] },
				lastRequestAt: now,
			}
		}],
		{ upsert: true, returnDocument: "after", updatePipeline: true }
	));

	if (log.count > MAX_OTP_REQUESTS_PER_HOUR) {
		await releaseOtpRequest(phoneNumber, log.windowStart);
		const retryAt = log.windowStart.getTime() + REQUEST_WINDOW_MS;
		return { allowed: false, windowStart: log.windowStart, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000)) };
	}

	return { allowed: true, windowStart: log.windowStart };
}


// Gives a reserved request back (provider failure, or the request was over the limit).
async function releaseOtpRequest(phoneNumber, windowStart) {
	await OtpRequestLog.updateOne(
		{ phoneNumber, windowStart, count: { $gt: 0 } },
		{ $inc: { count: -1 } }
	);
}


// US 01 registration, step 1 (AC-01, AC-02): reject registered phone numbers, otherwise
// send an OTP via WhatsApp. The user is created only after OTP verification (AC-03).
const register = async (req, res) => {

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

		// NFR-01: at most 5 OTP requests per phone per hour
		const now = new Date();
		const reservation = await reserveOtpRequest(phoneNumber, now);

		if (!reservation.allowed) {
			return res.status(429).json({
				error: "Too many verification code requests. Please try again later.",
				code: "OTP_RATE_LIMITED",
				retryAfterSeconds: reservation.retryAfterSeconds
			});
		}

		// AC-01: send the OTP via WhatsApp
		const sent = await sendWhatsAppOtp(phoneNumber);

		if (!sent) {
			await releaseOtpRequest(phoneNumber, reservation.windowStart);
			return res.status(502).json({ error: "Could not send the verification code. Please try again." });
		}

		// a new request replaces any earlier pending registration for this phone
		const sentAt = new Date();
		await retryOnDuplicateKey(() => RegistrationOtp.findOneAndUpdate(
			{ phoneNumber },
			{
				$set: {
					handleName,
					sentAt,
					expiresAt: new Date(sentAt.getTime() + OTP_EXPIRES_IN_SECONDS * 1000),
					failedAttempts: 0,
					status: "pending",
					purgeAt: new Date(sentAt.getTime() + PURGE_AFTER_MS),
				}
			},
			{ upsert: true }
		));

		return res.status(200).json({ sent: true, expiresInSeconds: OTP_EXPIRES_IN_SECONDS });

	}
	catch (err) {
		return serverError(res, err);
	}

}


// Explains why no pending registration could accept an attempt.
async function rejectionFor(phoneNumber, now) {

	const pending = await RegistrationOtp.findOne({ phoneNumber });

	if (!pending) {
		return { status: 400, code: "OTP_NOT_FOUND", error: "No pending registration for this phone number. Request a new code." };
	}

	if (pending.status === "consumed") {
		return { status: 400, code: "OTP_ALREADY_USED", error: "This code has already been used. Request a new code." };
	}

	if (pending.status === "invalidated" || pending.failedAttempts >= MAX_FAILED_ATTEMPTS) {
		return { status: 429, code: "OTP_ATTEMPTS_EXCEEDED", error: "Too many incorrect attempts. Request a new code." };
	}

	if (pending.expiresAt <= now) {
		return { status: 400, code: "OTP_EXPIRED", error: "This code has expired. Request a new code." };
	}

	return { status: 400, code: "OTP_NOT_FOUND", error: "No pending registration for this phone number. Request a new code." };
}


// US 01 registration, step 2 (AC-03, AC-04): verify the OTP, then create the user and
// return the same JWT response shape as Login.
const verifyRegistrationOtp = async (req, res) => {

	try {

		const phoneNumber = normalizeSaudiPhone(req.body.phoneNumber);
		const otp = typeof req.body.otp === "string" || typeof req.body.otp === "number" ? String(req.body.otp).trim() : "";

		if (!phoneNumber) {
			return res.status(400).json({ error: "Enter a valid Saudi mobile number." });
		}

		if (!otp) {
			return res.status(400).json({ error: "Enter the verification code." });
		}

		const now = new Date();

		// reserve one attempt atomically so concurrent guesses can't exceed the limit
		const pending = await RegistrationOtp.findOneAndUpdate(
			{
				phoneNumber,
				status: "pending",
				expiresAt: { $gt: now },
				failedAttempts: { $lt: MAX_FAILED_ATTEMPTS }
			},
			{ $inc: { failedAttempts: 1 } },
			{ returnDocument: "after" }
		);

		if (!pending) {
			const { status, code, error } = await rejectionFor(phoneNumber, now);
			return res.status(status).json({ error, code });
		}

		// Every later update is scoped to this OTP generation (_id + sentAt): a new code sent
		// while this request is in flight replaces the record, and this request must not
		// consume, invalidate or change the attempts of that newer code.
		const generation = { _id: pending._id, sentAt: pending.sentAt };

		const releaseAttempt = () => RegistrationOtp.updateOne(
			{ ...generation, failedAttempts: { $gt: 0 } },
			{ $inc: { failedAttempts: -1 } }
		);

		// Build and sign before consuming anything, so a signing problem (e.g. missing
		// JWT_SECRET) can never leave the code consumed or create an account.
		let user, token;
		try {
			user = new User({ handleName: pending.handleName, phoneNumber });
			token = jwt.sign(
				{ id: user._id, handleName: user.handleName, phoneNumber: user.phoneNumber },
				process.env.JWT_SECRET,
				{ expiresIn: process.env.JWT_EXPIRE || "30d" }
			);
		}
		catch (err) {
			await releaseAttempt().catch(() => {});
			return serverError(res, err);
		}

		const verdict = await verifyOtp(phoneNumber, otp);

		if (verdict === "error") {
			// provider problem, not the user's fault: give the attempt back
			await releaseAttempt();
			return res.status(502).json({ error: "Could not verify the code. Please try again." });
		}

		if (verdict === "invalid") {

			const attemptsRemaining = MAX_FAILED_ATTEMPTS - pending.failedAttempts;

			if (attemptsRemaining <= 0) {
				await RegistrationOtp.updateOne({ ...generation, status: "pending" }, { $set: { status: "invalidated" } });
				return res.status(429).json({
					error: "Incorrect code. Too many incorrect attempts, request a new code.",
					code: "OTP_ATTEMPTS_EXCEEDED"
				});
			}

			// AC-04
			return res.status(400).json({
				error: "The code you entered is incorrect. Please try again.",
				code: "OTP_INCORRECT",
				attemptsRemaining
			});
		}

		// valid: single use. Only the request that flips pending -> consumed continues.
		const claimed = await RegistrationOtp.findOneAndUpdate(
			{ ...generation, status: "pending" },
			{ $set: { status: "consumed" } },
			{ returnDocument: "after" }
		);

		if (!claimed) {

			// lost a race: a concurrent request used this code, or a newer code replaced it
			const current = await RegistrationOtp.findOne({ phoneNumber });

			if (current && current.status === "consumed" && String(current.sentAt) === String(pending.sentAt)) {
				return res.status(400).json({ error: "This code has already been used. Request a new code.", code: "OTP_ALREADY_USED" });
			}

			return res.status(400).json({ error: "A new code was sent. Please use the latest code.", code: "OTP_REPLACED" });
		}

		try {
			await user.save();
		}
		catch (err) {

			if (err && err.code === 11000) {
				// someone registered this phone between the check in register and now
				return res.status(409).json({ error: "This phone number is already registered." });
			}

			// nothing was created: let the user retry with the same code
			await RegistrationOtp.updateOne({ ...generation, status: "consumed" }, { $set: { status: "pending" } }).catch(() => {});
			throw err;
		}

		// AC-03: same shape as the Login response
		return res.status(201).json({
			message: "registration successful",
			token: token,
			id: user._id,
			handleName: user.handleName,
			phoneNumber: user.phoneNumber
		});

	}
	catch (err) {
		return serverError(res, err);
	}

}


module.exports = { register, verifyRegistrationOtp };
