
const mongoose = require("mongoose");
const { SAUDI_PHONE_REGEX } = require("../utils/constants");

const userSchema = new mongoose.Schema(
    {
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
            sparse: true
        },

        selectedGroupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Group",
            default: null
        },

        telegramStep: {
            type: String,
            enum: ["idle", "select_group", "select_item", "enter_quantity", "confirm_delete"],
            default: "idle"
        },

        // US 28, US 29: which Telegram flow the steps above belong to
        telegramAction: {
            type: String,
            enum: ["remove", "modify", null],
            default: null
        },

        // US 29: the item picked for modifying, while its new quantity is asked for
        telegramItemId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ListItem",
            default: null
        },

        pushTokens: {
            type: [String],
            default: []
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
