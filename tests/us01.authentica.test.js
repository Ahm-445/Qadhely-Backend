// US 01 AC-01: Authentica send-otp service — unit tests with a mocked fetch (Jest)
// Run from src/:  npm test
// No real Authentica / WhatsApp request is made, so these tests do not prove real delivery.

process.env.AUTHENTICA_API_KEY = "test-secret-key";

const { sendWhatsAppOtp } = require("../src/services/authentica");


const mockFetch = (response) => {
	global.fetch = jest.fn().mockResolvedValue(response);
};

const jsonResponse = (ok, status, body) => ({ ok, status, json: async () => body });

let errorSpy;

beforeEach(() => {
	errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errorSpy.mockRestore();
	delete global.fetch;
});


describe("sendWhatsAppOtp", () => {

	test("requests a WhatsApp OTP (not SMS) and resolves true when Authentica confirms", async () => {
		mockFetch(jsonResponse(true, 200, { success: true }));

		await expect(sendWhatsAppOtp("+966501234567")).resolves.toBe(true);

		const [url, options] = global.fetch.mock.calls[0];
		expect(url).toBe("https://api.authentica.sa/api/v2/send-otp");
		expect(options.method).toBe("POST");
		expect(options.headers["X-Authorization"]).toBe("test-secret-key");
		expect(JSON.parse(options.body)).toEqual({ method: "whatsapp", phone: "+966501234567" });
	});

	test("resolves false when Authentica responds with an error status", async () => {
		mockFetch(jsonResponse(false, 401, { success: false, message: "Unauthorized" }));

		await expect(sendWhatsAppOtp("+966501234567")).resolves.toBe(false);
	});

	test("resolves false when the response is OK but not confirmed", async () => {
		mockFetch(jsonResponse(true, 200, { success: false }));

		await expect(sendWhatsAppOtp("+966501234567")).resolves.toBe(false);
	});

	test("resolves false when the response body is not JSON", async () => {
		mockFetch({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });

		await expect(sendWhatsAppOtp("+966501234567")).resolves.toBe(false);
	});

	test("resolves false (does not throw) on a network error", async () => {
		global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

		await expect(sendWhatsAppOtp("+966501234567")).resolves.toBe(false);
	});

	test("never logs the API key or the phone number on failure", async () => {
		mockFetch(jsonResponse(false, 500, { success: false, message: "Server error" }));

		await sendWhatsAppOtp("+966501234567");

		const logged = JSON.stringify(errorSpy.mock.calls);
		expect(logged).not.toContain("test-secret-key");
		expect(logged).not.toContain("966501234567");
	});
});
