require("dotenv").config();

const PORT = process.env.PORT || 3000

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const morgan = require("morgan");
const errorHandler = require("./middleware/errorHandler");

//const connectDB = require("./config/db");

//const authRoutes = require("./src/routes/authRoutes");
//const path = require("path");


const app = express();

//connectDB();


// middleware

const corsMiddleware = require("./middleware/corsConfig");

app.use(cors(corsMiddleware));

app.use(express.json());

app.use(morgan("dev"));




const AUTHENTICA_URL = "https://api.authentica.sa/api/v2";
const OTP_METHOD = "whatsapp";


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


// Send OTP via WhatsApp

const { normalizeSaudiPhone } = require("./utils/normalizeSaudiPhone");

app.post('/auth/send-otp', async (req, res) => {
	
	const phone = normalizeSaudiPhone(req.body.phone);

	if (!phone) {
		return res.status(400).json({ error: 'Enter a valid Saudi mobile number' });
	}

	const { ok, data } = await authentica('/send-otp', { method: OTP_METHOD, phone });
	if (!ok || !data.success) {
		console.error('Authentica send-otp failed:', data);
		return res.status(502).json({ error: data.message || 'Could not send code' });
	}
	res.json({ sent: true });
});

// Verify OTP (same as before; phone is required for WhatsApp)
app.post('/auth/verify-otp', async (req, res) => {
	
	const phone = normalizeSaudiPhone(req.body.phone);

	if (!phone || !req.body.otp) {
		return res.status(400).json({ error: 'Phone and code are required' });
	}


	const { ok, data } = await authentica('/verify-otp', { phone, otp });
	if (!ok || data.status !== true) {
		return res.status(401).json({ error: data.message || 'Invalid code' });
	}

	res.json({ verified: true });
});

// to auth routes 
//app.use("/api/auth", authRoutes);





// health check
app.get("/", (req, res) => {
	console.log(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
	res.json({message: "SWE 381 project API is running"});
});



// global error handler
app.use(errorHandler);

app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
	console.log(`Environment: ${process.env.NODE_ENV}`);
});

