const mongoose = require("mongoose");

const User = require("../models/User");
const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const AccountDeletionOtp = require("../models/AccountDeletionOtp");
const OtpRequestLog = require("../models/OtpRequestLog");
const RegistrationOtp = require("../models/RegistrationOtp");

const { sendAuthOtp, verifyOtp } = require("../services/authentica");

const { ROLES } = Group;


// US 04 — Delete Account (SF-03 to SF-06, SF-12 to SF-15)
//
// Step 1  POST /api/account/delete/send-otp  -> sends a WhatsApp OTP to the logged-in user (AC-01)
// Step 2  POST /api/account/delete/verify    -> { otp, confirmed: true } checks the code and deletes the
//         account: the user leaves every group, their data and push tokens are removed (AC-02, AC-04).
//         A wrong code answers 400 OTP_INCORRECT so the app asks again (AC-03).
//
// Same limits as registration (NFR-01): the code is valid for 60 seconds, 5 wrong attempts,
// 5 codes per phone per hour (the hourly counter is shared with registration through OtpRequestLog).


const OTP_EXPIRES_IN_SECONDS = 60;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_OTP_REQUESTS_PER_HOUR = 5;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const PURGE_AFTER_MS = 10 * 60 * 1000;


const serverError = (res, err) => {
	console.error("[delete-account] unexpected error:", err.name, err.message);
	return res.status(500).json({ error: "Something went wrong. Please try again." });
};


async function retryOnDuplicateKey(fn) {
	try {
		return await fn();
	}
	catch (err) {
		if (err && err.code === 11000) return fn();
		throw err;
	}
}


// Counts one OTP request for the phone in a fixed 1-hour window (same rule as registration).
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

async function releaseOtpRequest(phoneNumber, windowStart) {
	await OtpRequestLog.updateOne(
		{ phoneNumber, windowStart, count: { $gt: 0 } },
		{ $inc: { count: -1 } }
	);
}


// The logged-in user, or null when the token's user no longer exists.
async function currentUser(req) {
	const id = req.user && req.user.id;
	if (!id || !mongoose.isValidObjectId(id)) return null;
	return User.findById(id);
}


// AC-01: send the OTP to the logged-in user's own phone number.
const sendDeleteAccountOtp = async (req, res) => {

	try {

		const user = await currentUser(req);

		if (!user) {
			return res.status(404).json({ error: "Account not found." });
		}

		const now = new Date();
		const reservation = await reserveOtpRequest(user.phoneNumber, now);

		if (!reservation.allowed) {
			return res.status(429).json({
				error: "Too many verification code requests. Please try again later.",
				code: "OTP_RATE_LIMITED",
				retryAfterSeconds: reservation.retryAfterSeconds
			});
		}

		const sent = await sendAuthOtp(user.phoneNumber);

		if (!sent) {
			await releaseOtpRequest(user.phoneNumber, reservation.windowStart);
			return res.status(502).json({ error: "Could not send the verification code. Please try again." });
		}

		// a new code replaces any earlier pending deletion for this user
		const sentAt = new Date();
		await retryOnDuplicateKey(() => AccountDeletionOtp.findOneAndUpdate(
			{ user: user._id },
			{
				$set: {
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

};


// Explains why no pending deletion could accept an attempt.
async function rejectionFor(userId, now) {

	const pending = await AccountDeletionOtp.findOne({ user: userId });

	if (!pending) {
		return { status: 400, code: "OTP_NOT_FOUND", error: "Request a verification code first." };
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

	return { status: 400, code: "OTP_NOT_FOUND", error: "Request a verification code first." };
}


// Takes the user out of one group, following the leave-group rules (SF-32 to SF-34):
// - the group is deleted, with its list, when nobody is left or the user was its only admin;
// - when the Group Creator leaves and other admins remain, one of them becomes the creator at random;
// - otherwise the user is simply removed.
// Returns "deleted" | "transferred" | "removed".
async function leaveGroup(group, userId) {

	const me = String(userId);
	const role = group.roleOf(me);
	const remaining = group.members.filter((m) => String(m.user) !== me);
	const remainingAdmins = remaining.filter((m) => Group.isAdminRole(m.role));

	if (remaining.length === 0 || (Group.isAdminRole(role) && remainingAdmins.length === 0)) {
		await ListItem.deleteMany({ group: group._id });
		await Group.deleteOne({ _id: group._id });
		return "deleted";
	}

	if (role === ROLES.CREATOR) {
		const heir = remainingAdmins[Math.floor(Math.random() * remainingAdmins.length)];
		const updated = remaining.map((m) => (String(m.user) === String(heir.user) ? { user: m.user, role: ROLES.CREATOR, joinedAt: m.joinedAt } : m));
		await Group.updateOne({ _id: group._id }, { $set: { members: updated, createdBy: heir.user } });
		return "transferred";
	}

	await Group.updateOne({ _id: group._id }, { $pull: { members: { user: group.members.find((m) => String(m.user) === me).user } } });
	return "removed";
}


// AC-02 to AC-04 and SF-14: verify the OTP, then delete the account.
const confirmDeleteAccount = async (req, res) => {

	try {

		// SF-14: the app must have shown the irreversible warning and the user must have accepted it
		if (req.body.confirmed !== true) {
			return res.status(400).json({ error: "Confirm that you want to permanently delete your account.", code: "CONFIRMATION_REQUIRED" });
		}

		const otp = typeof req.body.otp === "string" || typeof req.body.otp === "number" ? String(req.body.otp).trim() : "";

		if (!otp) {
			return res.status(400).json({ error: "Enter the verification code." });
		}

		const user = await currentUser(req);

		if (!user) {
			return res.status(404).json({ error: "Account not found." });
		}

		const now = new Date();

		// reserve one attempt atomically so concurrent guesses can't exceed the limit
		const pending = await AccountDeletionOtp.findOneAndUpdate(
			{
				user: user._id,
				status: "pending",
				expiresAt: { $gt: now },
				failedAttempts: { $lt: MAX_FAILED_ATTEMPTS }
			},
			{ $inc: { failedAttempts: 1 } },
			{ returnDocument: "after" }
		);

		if (!pending) {
			const { status, code, error } = await rejectionFor(user._id, now);
			return res.status(status).json({ error, code });
		}

		const generation = { _id: pending._id, sentAt: pending.sentAt };

		const verdict = await verifyOtp(user.phoneNumber, otp);

		if (verdict === "error") {
			// provider problem, not the user's fault: give the attempt back
			await AccountDeletionOtp.updateOne({ ...generation, failedAttempts: { $gt: 0 } }, { $inc: { failedAttempts: -1 } });
			return res.status(502).json({ error: "Could not verify the code. Please try again." });
		}

		if (verdict === "invalid") {

			const attemptsRemaining = MAX_FAILED_ATTEMPTS - pending.failedAttempts;

			if (attemptsRemaining <= 0) {
				await AccountDeletionOtp.updateOne({ ...generation, status: "pending" }, { $set: { status: "invalidated" } });
				return res.status(429).json({ error: "Incorrect code. Too many incorrect attempts, request a new code.", code: "OTP_ATTEMPTS_EXCEEDED" });
			}

			// AC-03
			return res.status(400).json({
				error: "The code you entered is incorrect. Please try again.",
				code: "OTP_INCORRECT",
				attemptsRemaining
			});
		}

		// valid: single use. Only the request that flips pending -> consumed deletes the account.
		const claimed = await AccountDeletionOtp.findOneAndUpdate(
			{ ...generation, status: "pending" },
			{ $set: { status: "consumed" } },
			{ returnDocument: "after" }
		);

		if (!claimed) {
			return res.status(400).json({ error: "This code has already been used. Request a new code.", code: "OTP_ALREADY_USED" });
		}

		// AC-02: leave every group the user participates in
		const groups = await Group.find({ "members.user": user._id });
		const summary = { deleted: 0, transferred: 0, removed: 0 };

		for (const group of groups) {
			summary[await leaveGroup(group, user._id)] += 1;
		}

		// AC-02 / AC-04: delete the user's data. The push tokens live on the user document,
		// so no notification can be addressed to their phones any more.
		await RegistrationOtp.deleteMany({ phoneNumber: user.phoneNumber });
		await AccountDeletionOtp.deleteMany({ user: user._id });
		await User.deleteOne({ _id: user._id });

		return res.status(200).json({ deleted: true, groups: summary });

	}
	catch (err) {
		return serverError(res, err);
	}

};


module.exports = { sendDeleteAccountOtp, confirmDeleteAccount, leaveGroup };
