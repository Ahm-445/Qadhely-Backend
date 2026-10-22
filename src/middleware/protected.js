const jwt = require("jsonwebtoken");

// check jwt authorization

const protect = (req, res, next) => {
	

	const authHeader = req.headers.authorization;
	
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return res.status(401).json({error: "No Token - Access denied"})
	}
	// extract token
					// array containting ["Bearer", <token>]
	const token = authHeader.split(" ") [1];

	console.log(token);

	// check if token is valid
	try {
		
		const decoded = jwt.verify(token, process.env.JWT_SECRET);

		const user = decoded;

		console.log(user);

		req.user = user;

		next();

	}
	catch (err) {
		res.status(401).json({error: "Invalid or expired token"})
	}	

}


module.exports = protect;