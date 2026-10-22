const cors = require("cors")

const allowedOrigins = [
	process.env.FRONTEND_URL,
  	"http://localhost:5173"
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
