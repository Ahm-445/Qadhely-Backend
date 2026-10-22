const errorHandler = (err, req, res, next) => {
	
	console.error("[ERROR]", err); // log error

	// custom error or default (500)
	const statusCode = err.statusCode || 500;
	
	const response = {
		error: err.message || "Internal Server Error",
		messages: err.messages || "No details"
	}
	/*
	if (process.env.NODE_ENV === "development") { // for dev
		response.stack = err.stack;
	}
	*/
	res.status(statusCode).json(response);

};


module.exports = errorHandler;