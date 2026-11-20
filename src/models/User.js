const mongoose = require("mongoose");
const {SAUDI_PHONE_REGEX} = require("../utils/constants");


const userSchema = new mongoose.Schema ({
	
		handleName: {
			type: String,
			required: [true, "Handle name is required."],
			trim: true,
			default: "user1"
		},

		phoneNumber: {
			type: String,
			required: [true, "Phone number is required."],
			unique: true,
			trim: true,
			match: [SAUDI_PHONE_REGEX, "Phone number must be Saudi."]
		},
		telegramChatId: {
    		type: String,
    		unique: true,
   			 sparse: true,
		},
		// push tokens of the phones this user is logged in on
		pushTokens: {
			type: [String],
			default: []
		},

	}, 
	{timestamps: true}
);




module.exports = mongoose.model("User", userSchema);