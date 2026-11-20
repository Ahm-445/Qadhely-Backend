
const axios = require("axios");

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

const sendTelegramMessage = async (chatId, text, options = {}) => {
    try {
        const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text,
            ...options,
        });

        return response.data;
    } catch (error) {
        console.error(
            "Telegram sendMessage failed:",
            error.response?.data || error.message
        );
        throw error;
    }
};

const answerCallbackQuery = async (callbackQueryId) => {
    try {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callbackQueryId,
        });
    } catch (error) {
        console.error("Telegram callback error:", error.message);
    }
};

module.exports = {
    sendTelegramMessage,
    answerCallbackQuery,
};
