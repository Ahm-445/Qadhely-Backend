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


// Checks an OTP with Authentica. Resolves to:
//   "valid"   - Authentica answered 200 with { status: true } (documented success response)
//   "invalid" - the code was not accepted (200 without status:true, or a 4xx other than
//               401/403/429). Authentica documents no error body for a wrong or expired
//               code, so this classification is an assumption to confirm with the provider.
//   "error"   - provider/network failure, or our API key was rejected (401/403), or 429/5xx
// Never throws and never logs the API key, phone number or OTP.
async function verifyOtp(phone, otp) {

	try {

		const res = await fetch(`${AUTHENTICA_URL}/verify-otp`, {
			method: "POST",
			headers: {
				"X-Authorization": process.env.AUTHENTICA_API_KEY,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ phone, otp }),
		});

		const data = await res.json().catch(() => ({}));

		if (res.ok) {
			return data.status === true ? "valid" : "invalid";
		}

		if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
			console.error("Authentica verify-otp failed:", res.status);
			return "error";
		}

		return "invalid";

	}
	catch (err) {
		console.error("Authentica verify-otp error:", err.message);
		return "error";
	}

}


module.exports = { sendWhatsAppOtp, verifyOtp };
