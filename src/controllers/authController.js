const jwt = require("jsonwebtoken");
const User = require("../models/User");

const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone")


const AUTHENTICA_URL = "https://api.authentica.sa/api/v2";
const OTP_METHOD = "whatsapp";
const OTP_METHOD = "sms";



async function authentica(path, body) {
	const res = await fetch(`${AUTHENTICA_URL}${path}`, {
		method: 'POST',
		headers: {
			'X-Authorization': process.env.AUTHENTICA_API_KEY,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	return { ok: res.ok, data };
}




const loginSendOTP = async (req, res, next) => {
	
	try {
	
		// validate number
		const phoneNumber = normalizeSaudiPhone(req.body.phoneNumber);
	
		if (!phoneNumber) {
			return res.status(400).json({ error: "Enter a valid Saudi mobile number." });
		}
	
		// check if number exists
		const user = await User.findOne({phoneNumber}); // find user
	
		if (!user) {
			return res.status(401).json({error: "User Not found. Register first before logging in."});
		}
	
		// send OTP
		const { ok, data } = await authentica('/send-otp', { method: OTP_METHOD, phone: phoneNumber });
	
		if (!ok || !data.success) {
	
			console.error('Authentica send-otp failed:', data);
			return res.status(502).json({ error: data.message || 'Could not send code' });
	
		}
	
		res.status(200).json({ sent: true });
			
			
	
	}
	catch (err) {
		console.log(err);
		res.status(500).json({error: "Failed to send otp"});
	}
	
}


const loginRecieveOTP = async (req, res) => {
	try {

		// validate number and opt
		const phoneNumber = normalizeSaudiPhone(req.body.phoneNumber);
		const OTP = req.body.otp

		if (!phoneNumber || !OTP) {
			return res.status(400).json({ error: "Enter a valid Saudi mobile number." });
		}


		// check if number exists
		const user = await User.findOne({phoneNumber}); // find user

		if (!user) {
			return res.status(401).json({error: "User Not found. Register first before logging in."});
		}

		// verify otp
		const { ok, data } = await authentica('/verify-otp', { phone: phoneNumber, otp: OTP });
		
		if (!ok || data.status !== true) {
			return res.status(401).json({ error: data.message || 'Invalid code' });
		}

		
		const payload = {
			id: user._id,
			handleName: user.handleName,
			phoneNumber: user.phoneNumber
		}

		const token = jwt.sign(
			payload,
			process.env.JWT_SECRET,
			{expiresIn: process.env.JWT_EXPIRE || "30d"}
		);


		res.status(200).json({
			message: "login successful",
			token: token,
			id: user._id,
			handleName: user.handleName,
			phoneNumber: user.phoneNumber
		});

	}
	catch (err) {
		console.log(err);
		res.status(500).json({error: "Failed to login"});
	}

}


module.exports = {loginSendOTP, loginRecieveOTP}
