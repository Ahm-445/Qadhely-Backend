const cors = require("cors")

const allowedOrigins = [
	process.env.FRONTEND_URL,
  	"http://localhost:8081"
]


const corsOptions = {

	origin: allowedOrigins,

	methods: ["GET", "POST", "PUT", "DELETE"],

	allowedHeaders: [
		"Content-Type", 
		"Authorization"],

	credentials: true
}

module.exports = cors(corsOptions)
