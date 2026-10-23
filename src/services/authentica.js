const AUTHENTICA_URL = "https://api.authentica.sa/api/v2";
const OTP_METHOD = "whatsapp";


// Sends an OTP through Authentica over WhatsApp (SF-03).
// Resolves to true only when Authentica confirms the request; never throws and
// never logs the API key or the phone number.
async function sendWhatsAppOtp(phone) {

	try {

		const res = await fetch(`${AUTHENTICA_URL}/send-otp`, {
			method: "POST",
			headers: {
				"X-Authorization": process.env.AUTHENTICA_API_KEY,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ method: OTP_METHOD, phone }),
		});

		const data = await res.json().catch(() => ({}));

		if (!res.ok || data.success !== true) {
			console.error("Authentica send-otp failed:", res.status, data.message || "");
			return false;
		}

		return true;

	}
	catch (err) {
		console.error("Authentica send-otp error:", err.message);
		return false;
	}

}


module.exports = { sendWhatsAppOtp };
