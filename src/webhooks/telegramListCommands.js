
const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { UNITS } = ListItem;
const { getCatalogItem } = require("../services/catalog");
const { quantityError } = require("../controllers/listItemController");
const { sendTelegramMessage } = require("../services/telegramService");
const { orderItems } = require("../services/telegramItems");

// US 28 — remove an item, and US 29 — modify an item's quantity and unit, from Telegram.
// The admin sends /remove or /modify, picks an item by its number, and (US 29) sends the new
// quantity and unit. /cancel stops at any step and changes nothing.

const CANCEL_HINT = "Send /cancel to stop.";

// "2 piece", "1.5 kg", "3 boxes"
const UNIT_WORDS = {
    kg: UNITS.KG,
    piece: UNITS.PIECE,
    pieces: UNITS.PIECE,
    box: UNITS.BOX,
    boxes: UNITS.BOX,
};


// an Arabic keyboard sends ٣ or ٫
function toLatinDigits(text) {
    return text
        .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
        .replace(/[٫,]/g, ".");
}

function itemName(item) {
    const catalogItem = item.catalogItemId ? getCatalogItem(item.catalogItemId) : null;

    return catalogItem?.name_en ?? item.customName ?? item.catalogItemId ?? "Item";
}

function itemStore(item) {
    const catalogItem = item.catalogItemId ? getCatalogItem(item.catalogItemId) : null;

    return catalogItem?.store ?? item.customStore ?? null;
}

// "1. Large White Eggs Plastic Packaging — 2 box (Tamimi)"
function formatItemList(items) {
    return items
        .map((item, index) => {
            const store = itemStore(item);
            return `${index + 1}. ${itemName(item)} — ${item.quantity} ${item.unit}${store ? ` (${store})` : ""}`;
        })
        .join("\n");
}

// the new quantity and unit, or null when the text is not "<number> <unit>"
function parseQuantityAndUnit(text) {
    const match = toLatinDigits(text).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);

    if (!match || !UNIT_WORDS[match[2]]) return null;

    return { quantity: Number(match[1]), unit: UNIT_WORDS[match[2]] };
}

// shortcut: the list is read again for every reply, so an item added or removed in the app between
// showing the list and picking a number shifts the numbers; store the shown ids if that happens in practice
// the same order as /items (US 27), so a number means the same item in both
async function loadItems(groupId) {
    return orderItems(await ListItem.find({ group: groupId }).lean());
}

async function resetFlow(user) {
    user.telegramStep = "idle";
    user.telegramAction = null;
    user.telegramItemId = null;
    await user.save();
}

async function sendUpdatedList(chatId, groupId, intro) {
    const items = await loadItems(groupId);

    const list = items.length ? `Your shopping list:\n${formatItemList(items)}` : "Your shopping list is now empty.";

    return sendTelegramMessage(chatId, `${intro}\n\n${list}`);
}


// /remove and /modify: show the numbered list and ask for an item (US 28 AC-01, US 29 AC-01)
async function startFlow(chatId, user, action) {
    const items = await loadItems(user.selectedGroupId);

    if (items.length === 0) {
        await resetFlow(user);
        return sendTelegramMessage(chatId, "Your shopping list is empty.");
    }

    user.telegramStep = "select_item";
    user.telegramAction = action;
    user.telegramItemId = null;
    await user.save();

    const ask = action === "remove" ? "Send the number of the item to remove." : "Send the number of the item to modify.";

    return sendTelegramMessage(chatId, `Your shopping list:\n${formatItemList(items)}\n\n${ask}\n${CANCEL_HINT}`);
}


// the admin sent an item number (US 28 AC-02, US 29 AC-02)
async function pickItem(chatId, user, text) {
    const items = await loadItems(user.selectedGroupId);
    const number = Number(toLatinDigits(text).trim());

    // US 28 AC-04, US 29 AC-05: an invalid input is reported and the step is asked again
    if (!Number.isInteger(number) || number < 1 || number > items.length) {
        return sendTelegramMessage(
            chatId,
            `That input is incorrect. Send a number from 1 to ${items.length}.\n${CANCEL_HINT}`
        );
    }

    const item = items[number - 1];

    if (user.telegramAction === "remove") {
        // the group is part of the filter, as in DELETE /api/groups/:groupId/items/:itemId (US 13)
        await ListItem.findOneAndDelete({ _id: item._id, group: user.selectedGroupId });
        await resetFlow(user);

        return sendUpdatedList(chatId, user.selectedGroupId, `Removed ${itemName(item)}.`);
    }

    user.telegramStep = "enter_quantity";
    user.telegramItemId = item._id;
    await user.save();

    return sendTelegramMessage(
        chatId,
        `Send the new quantity and unit for ${itemName(item)}, for example: 2 piece, 1.5 kg or 1 box.\n${CANCEL_HINT}`
    );
}


// the admin sent the new quantity and unit (US 29 AC-03)
async function modifyItem(chatId, user, text) {
    const change = parseQuantityAndUnit(text);

    // US 29 AC-05: the same rules as the app (US 14), and the step is asked again
    const invalid = change ? quantityError(change.quantity, change.unit) : "Send a number and a unit (kg, piece or box), for example: 2 piece.";

    if (invalid) {
        return sendTelegramMessage(chatId, `That input is incorrect. ${invalid}\n${CANCEL_HINT}`);
    }

    const item = await ListItem.findOne({ _id: user.telegramItemId, group: user.selectedGroupId });

    if (!item) {
        await resetFlow(user);
        return sendUpdatedList(chatId, user.selectedGroupId, "That item is no longer on the list.");
    }

    // save() rather than an update query, so the model's quantity-by-unit validator still runs (as in US 14)
    item.quantity = change.quantity;
    item.unit = change.unit;
    await item.save();
    await resetFlow(user);

    return sendUpdatedList(chatId, user.selectedGroupId, `Updated ${itemName(item)} to ${item.quantity} ${item.unit}.`);
}


/**
 * Handles a text from an admin who has a selected group. Returns false when the text is not a
 * remove or modify command and no remove or modify step is waiting for it.
 */
async function handleListCommand(chatId, user, text) {
    const command = text.trim().toLowerCase();
    const inFlow = user.telegramAction !== null && user.telegramStep !== "idle";

    if (!["/remove", "/modify", "/cancel"].includes(command) && !inFlow) return false;

    // US 28 AC-03, US 29 AC-04: cancelling changes nothing
    if (command === "/cancel") {
        await resetFlow(user);
        await sendTelegramMessage(chatId, "Cancelled. Your shopping list was not changed.");
        return true;
    }

    // the admin may have lost the role, or the group may be gone, since it was selected
    const group = await Group.findById(user.selectedGroupId).select("members");

    if (!group || !Group.isAdminRole(group.roleOf(user._id))) {
        await resetFlow(user);
        await sendTelegramMessage(chatId, "You do not have permission to manage this group.");
        return true;
    }

    if (command === "/remove" || command === "/modify") {
        await startFlow(chatId, user, command.slice(1));
    } else if (user.telegramStep === "select_item") {
        await pickItem(chatId, user, text);
    } else if (user.telegramStep === "enter_quantity" && user.telegramAction === "modify") {
        await modifyItem(chatId, user, text);
    } else {
        await resetFlow(user);
        return false;
    }

    return true;
}


module.exports = { handleListCommand, formatItemList, parseQuantityAndUnit };
