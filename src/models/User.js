const mongoose = require("mongoose");


const userSchema = new mongoose.Schema ({
	
	handleName: {
		type: String,
		required: [true, "Handle name is required"],
		trim: true,
		default: "user1"
	},

	phoneNumber: {
		type: String,
		required: [true, "phone number is required"],
		unique: true,
		lowercase: true,
		trim: true
	},


}, {timestamps: true});




module.exports = mongoose.model("User", userSchema);