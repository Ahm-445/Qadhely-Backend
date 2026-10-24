const mongoose = require("mongoose");
const dns = require("dns");

// this is the dns address that allows us to resolve the url correctly
dns.setServers([
	"1.1.1.1",
])

const connectDB = async () => {
	try {
		
		await mongoose.connect(process.env.MONGO_URI);
		console.log("MongoDB atlas connected");
	}
	catch(err) {
		console.error("Failed to connect to DB: ", err);
		process.exit(1);
	}

}

module.exports = connectDB;