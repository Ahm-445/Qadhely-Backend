require("dotenv").config();

const PORT = process.env.PORT || 3000;
const IP_ADDRESS = process.env.LOCAL_IP || "localhost";

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const morgan = require("morgan");
const errorHandler = require("./middleware/errorHandler");

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const devicesRoute = require("./routes/devicesRoute");
const groupRoutes = require("./routes/groupRoutes");
const contactRoutes = require("./routes/contactRoutes");

const User = require("./models/User");



const app = express();

connectDB();




// middleware

const corsMiddleware = require("./middleware/corsConfig");

app.use(corsMiddleware);

app.use(express.json());

app.use(morgan("dev"));




const AUTHENTICA_URL = "https://api.authentica.sa/api/v2";
const OTP_METHOD = "whatsapp";



// to auth routes 
app.use("/api/auth", authRoutes);

// push tokens: link the phone on login, unlink it on logout
app.use("/api/devices", devicesRoute);

// US 05 — shopping list groups
app.use("/api/groups", groupRoutes);
app.use("/api/contacts", contactRoutes);

/*
// comment once done
app.get("/testCreateUser", async (req, res, next) => {
	
	try {

		const user = await User.create({
			handleName: "",
			phoneNumber: "+966555555555"
		});

		console.log(user);

		return res.status(201).json(user);
		
	}
	catch (err) {
		next(err)
	}

});
*/


// health check
app.get("/", (req, res) => {
	console.log(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
	res.json({message: "SWE 381 project API is running"});
});



// global error handler
app.use(errorHandler);

app.listen(PORT, () => {
	console.log(`Server is running on //${IP_ADDRESS}:${PORT}`);
	console.log(`Environment: ${process.env.NODE_ENV}`);
});

