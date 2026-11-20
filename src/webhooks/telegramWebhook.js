
const express = require("express");
const router = express.Router();

const User = require("../models/User");
const Group = require("../models/Group");
const { normalizeSaudiPhone } = require("../utils/normalizeSaudiPhone");

const {
    sendTelegramMessage,
    answerCallbackQuery,
} = require("../services/telegramService");
const { handleListCommand } = require("./telegramListCommands");

const contactKeyboard = {
    keyboard: [
        [{ text: "Share my phone number", request_contact: true }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
};

async function showAdminGroups(chatId, user) {
    const groups = await Group.find({
        "members.user": user._id,
    }).sort({ updatedAt: -1 });

    const adminGroups = groups.filter((group) =>
        Group.isAdminRole(group.roleOf(user._id))
    );

    if (adminGroups.length === 0) {
        user.selectedGroupId = null;
        user.telegramStep = "idle";
        await user.save();

        return sendTelegramMessage(
            chatId,
            "Your Qadhely account is connected, but you are not an admin of any shopping list."
        );
    }

    if (adminGroups.length === 1) {
        user.selectedGroupId = adminGroups[0]._id;
        user.telegramStep = "idle";
        await user.save();

        return sendTelegramMessage(
            chatId,
            `You can manage your shopping list using Qadhely Telegram Bot.\n\nSelected list: ${adminGroups[0].name}`,
            { reply_markup: { remove_keyboard: true } }
        );
    }

    user.selectedGroupId = null;
    user.telegramStep = "select_group";
    await user.save();

    const keyboard = adminGroups.map((group) => [{
        text: group.name,
        callback_data: `group:${group._id}`,
    }]);

    return sendTelegramMessage(
        chatId,
        "You have more than one shopping list. Please select which group you want to manage:",
        { reply_markup: { inline_keyboard: keyboard } }
    );
}

router.post("/", async (req, res) => {
    try {
        // Verify Telegram webhook secret
        const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
        const receivedSecret = req.get("X-Telegram-Bot-Api-Secret-Token");

        if (!expectedSecret || receivedSecret !== expectedSecret) {
            return res.sendStatus(401);
        }

        const message = req.body?.message;
        const callback = req.body?.callback_query;

        // Handle group selection
        if (callback) {
            const chatId = callback.message?.chat?.id;
            const fromId = callback.from?.id;
            const data = callback.data || "";

            await answerCallbackQuery(callback.id);

            if (
                !chatId ||
                !fromId ||
                String(chatId) !== String(fromId) ||
                !data.startsWith("group:")
            ) {
                return res.sendStatus(200);
            }

            const user = await User.findOne({
                telegramChatId: String(chatId),
            });

            if (!user) {
                await sendTelegramMessage(
                    chatId,
                    "Please connect your Qadhely account first by sending /start."
                );
                return res.sendStatus(200);
            }

            const groupId = data.slice("group:".length);

            const group = await Group.findOne({
                _id: groupId,
                "members.user": user._id,
            });

            if (!group || !Group.isAdminRole(group.roleOf(user._id))) {
                await sendTelegramMessage(
                    chatId,
                    "You do not have permission to manage this group."
                );
                return res.sendStatus(200);
            }

            user.selectedGroupId = group._id;
            user.telegramStep = "idle";
            await user.save();

            await sendTelegramMessage(
                chatId,
                `You can manage your shopping list using Qadhely Telegram Bot.\n\nSelected list: ${group.name}`
            );

            return res.sendStatus(200);
        }

        if (!message) {
            return res.sendStatus(200);
        }

        const chatId = message.chat?.id;
        const fromId = message.from?.id;
        const text = message.text?.trim();

        if (!chatId || !fromId || message.chat?.type !== "private") {
            return res.sendStatus(200);
        }

        if (text === "/start") {
            await sendTelegramMessage(
                chatId,
                "Welcome to Qadhely!\n\nTo connect your account and access your shopping lists, please share your phone number using the button below.",
                { reply_markup: contactKeyboard }
            );

            return res.sendStatus(200);
        }

        // Handle shared contact
        if (message.contact) {
            const contact = message.contact;

            if (String(contact.user_id) !== String(fromId)) {
                await sendTelegramMessage(
                    chatId,
                    "Please share your own phone number using the button."
                );
                return res.sendStatus(200);
            }

            const phoneNumber = normalizeSaudiPhone(contact.phone_number);

            if (!phoneNumber) {
                await sendTelegramMessage(
                    chatId,
                    "Invalid Saudi phone number. Please try again."
                );
                return res.sendStatus(200);
            }

            const user = await User.findOne({ phoneNumber });

            if (!user) {
                await sendTelegramMessage(
                    chatId,
                    "No Qadhely account was found with this phone number."
                );
                return res.sendStatus(200);
            }

            // Do not replace an existing Telegram connection
            if (
                user.telegramChatId &&
                user.telegramChatId !== String(chatId)
            ) {
                await sendTelegramMessage(
                    chatId,
                    "This Qadhely account is already connected to another Telegram account. Please contact support."
                );
                return res.sendStatus(200);
            }

            // Do not allow one Telegram chat to connect to another Qadhely account
            const existingLink = await User.findOne({
                telegramChatId: String(chatId),
                _id: { $ne: user._id },
            });

            if (existingLink) {
                await sendTelegramMessage(
                    chatId,
                    "This Telegram account is already connected to another Qadhely account."
                );
                return res.sendStatus(200);
            }

            user.telegramChatId = String(chatId);
            user.telegramStep = "idle";
            await user.save();

            await sendTelegramMessage(
                chatId,
                "Your Qadhely account has been connected successfully!",
                { reply_markup: { remove_keyboard: true } }
            );

            await showAdminGroups(chatId, user);

            return res.sendStatus(200);
        }

        if (text) {
            const user = await User.findOne({
                telegramChatId: String(chatId),
            });

            if (user) {
                if (user.telegramStep === "select_group") {
                    await showAdminGroups(chatId, user);
                } else if (user.selectedGroupId) {
                    // US 28, US 29: /remove, /modify, /cancel and their steps
                    if (!(await handleListCommand(chatId, user, text))) {
                        await sendTelegramMessage(
                            chatId,
                            "Your selected shopping list is saved.\n\nSend /remove to remove an item or /modify to change an item's quantity and unit."
                        );
                    }
                } else {
                    await showAdminGroups(chatId, user);
                }
            } else {
                await sendTelegramMessage(
                    chatId,
                    "Please send /start to connect your Qadhely account first."
                );
            }
        }

        return res.sendStatus(200);
    } catch (error) {
        console.error("Telegram webhook error:", error.message);
        return res.sendStatus(200);
    }
});

module.exports = router;
