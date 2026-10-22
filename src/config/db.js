const mongoose = require("mongoose");


// connect to MongoDB Atlas using MONGO_URI from .env

const connectDB = async () => {
	try {

		if (!process.env.MONGO_URI) {
			throw new Error("MONGO_URI is missing in .env");
		}

		const conn = await mongoose.connect(process.env.MONGO_URI);

		console.log(`MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);

	}
	catch (err) {
		console.error("MongoDB connection failed:", err.message);
		process.exit(1);
	}
};


module.exports = connectDB;
