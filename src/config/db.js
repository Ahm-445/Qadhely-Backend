const mongoose = require("mongoose");
const dns = require("dns");

// Optional: some networks can't resolve the Atlas address with their own DNS.
// If yours can't, set DNS_SERVERS in .env (e.g. DNS_SERVERS=1.1.1.1,8.8.8.8).
if (process.env.DNS_SERVERS) {
	dns.setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()));
}

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