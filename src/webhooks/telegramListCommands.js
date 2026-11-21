
const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { UNITS } = ListItem;
const { getCatalogItem, searchCatalog } = require("../services/catalog");
const { quantityError } = require("../controllers/listItemController");
const { sendTelegramMessage } = require("../services/telegramService");
const { orderItems } = require("../services/telegramItems");
const { recordAddition } = require("../services/itemHistory");
const { notifyItemsAdded } = require("../services/pushNotifications");

// US 28 — remove an item, and US 29 — modify an item's quantity and unit, from Telegram.
// The admin sends /remove or /modify, picks an item by its number, and (US 29) sends the new
// quantity and unit. /cancel stops at any step and changes nothing.
//
// Telegram add items — the admin sends /add (or "/add milk"), searches the catalog, picks one of
// the top 20 results by its number, and sends the quantity and unit. The item is added exactly as
// from the app (US 12) and the updated list is sent back.

const CANCEL_HINT = "Send /cancel to stop.";

// AC-01: the top 20 catalog results
const SEARCH_RESULTS_MAX = 20;
const SEARCH_TEXT_MAX = 100;

const QUANTITY_PROMPT = "Send the quantity and unit (kg, piece or box), for example: 2 piece, 1.5 kg or 1 box.";

// "/add", "/add@QadhelyBot", "/add fresh milk"; the search words, or "" when there are none
function parseAddCommand(text) {
    const match = text.trim().match(/^\/add(?:@\w+)?(?:\s+([\s\S]*))?$/i);

    return match ? (match[1] ?? "").trim() : null;
}

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
    user.telegramSearchResults = [];
    user.telegramCatalogItemId = null;
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


// ---------------------------------------------------------------------------------------------
// Telegram add items

// "1. Fresh Milk Full Fat — 1 L (Tamimi)"
function formatSearchResults(products) {
    return products
        .map((product, index) => {
            const size = product.size_text && !product.name_en.toLowerCase().includes(product.size_text.toLowerCase())
                ? ` ${product.size_text}`
                : "";

            return `${index + 1}. ${product.name_en}${size}${product.store ? ` (${product.store})` : ""}`;
        })
        .join("\n");
}


// /add with no words: ask what to search for (`intro` explains why the search starts over)
async function startAddFlow(chatId, user, intro = null) {
    user.telegramStep = "enter_search";
    user.telegramAction = "add";
    user.telegramItemId = null;
    user.telegramSearchResults = [];
    user.telegramCatalogItemId = null;
    await user.save();

    const ask = `Send the name of the item you want to add, for example: milk.\n${CANCEL_HINT}`;

    return sendTelegramMessage(chatId, intro ? `${intro} ${ask}` : ask);
}


// the admin sent what to search for (AC-01)
async function searchForItem(chatId, user, text) {
    const query = text.trim();

    // "/add milk" can start the flow from any step
    if (user.telegramAction !== "add" || !["enter_search", "select_result"].includes(user.telegramStep)) {
        user.telegramStep = "enter_search";
        user.telegramAction = "add";
        user.telegramItemId = null;
        user.telegramSearchResults = [];
        user.telegramCatalogItemId = null;
        await user.save();
    }

    // AC-05: an empty, too long or command-like search is reported and asked again; results already
    // shown stay valid, so the admin can still pick one of them
    if (!query || query.startsWith("/") || query.length > SEARCH_TEXT_MAX) {
        return sendTelegramMessage(
            chatId,
            `That input is incorrect. Send the name of an item (up to ${SEARCH_TEXT_MAX} characters), for example: milk.\n${CANCEL_HINT}`
        );
    }

    const { total, items } = searchCatalog(query, { limit: SEARCH_RESULTS_MAX });

    if (items.length === 0) {
        user.telegramStep = "enter_search";
        user.telegramSearchResults = [];
        await user.save();

        return sendTelegramMessage(chatId, `No items were found for "${query}". Send another name to search again.\n${CANCEL_HINT}`);
    }

    user.telegramStep = "select_result";
    user.telegramSearchResults = items.map((product) => product.id);
    user.telegramCatalogItemId = null;
    await user.save();

    const heading = total > items.length
        ? `Top ${items.length} of ${total} results for "${query}":`
        : `Results for "${query}":`;

    return sendTelegramMessage(
        chatId,
        `${heading}\n${formatSearchResults(items)}\n\nSend the number of the item to add, or send another name to search again.\n${CANCEL_HINT}`
    );
}


// the admin sent a result number (AC-02), or a new search
async function pickSearchResult(chatId, user, text) {
    const results = user.telegramSearchResults || [];
    const latin = toLatinDigits(text).trim();

    // anything that is not a number is a new search
    if (!/^\d+$/.test(latin)) {
        return searchForItem(chatId, user, text);
    }

    const number = Number(latin);

    // AC-05: a number that is not on the list is reported and asked again
    if (number < 1 || number > results.length) {
        return sendTelegramMessage(
            chatId,
            `That input is incorrect. Send a number from 1 to ${results.length}, or another name to search again.\n${CANCEL_HINT}`
        );
    }

    const product = getCatalogItem(results[number - 1]);

    if (!product) {
        return startAddFlow(chatId, user, "That item is no longer in the catalog.");
    }

    user.telegramStep = "enter_quantity";
    user.telegramCatalogItemId = product.id;
    await user.save();

    return sendTelegramMessage(chatId, `How much ${product.name_en} do you need?\n${QUANTITY_PROMPT}\n${CANCEL_HINT}`);
}


// the admin sent the quantity and unit (AC-03)
async function addItem(chatId, user, text) {
    const change = parseQuantityAndUnit(text);

    // AC-05: the same rules as the app (US 12 AC-03), and the step is asked again
    const invalid = change ? quantityError(change.quantity, change.unit) : `Send a number and a unit (kg, piece or box), for example: 2 piece.`;

    if (invalid) {
        return sendTelegramMessage(chatId, `That input is incorrect. ${invalid}\n${CANCEL_HINT}`);
    }

    const product = user.telegramCatalogItemId ? getCatalogItem(user.telegramCatalogItemId) : null;

    if (!product) {
        return startAddFlow(chatId, user, "That item is no longer in the catalog.");
    }

    const item = await ListItem.create({
        group: user.selectedGroupId,
        catalogItemId: product.id,
        quantity: change.quantity,
        unit: change.unit,
        addedBy: user._id,
    });

    // the same follow-up as an addition from the app (POST /api/groups/:groupId/items):
    // the item history for the AI suggestions, and the US 18 "items added" notification (not awaited)
    await recordAddition(item);
    notifyItemsAdded(user.selectedGroupId, user._id);

    await resetFlow(user);

    return sendUpdatedList(chatId, user.selectedGroupId, `Added ${itemName(item)} — ${item.quantity} ${item.unit}.`);
}


/**
 * Handles a text from an admin who has a selected group. Returns false when the text is not an
 * add, remove or modify command and no add, remove or modify step is waiting for it.
 */
async function handleListCommand(chatId, user, text) {
    const command = text.trim().toLowerCase();
    const addSearch = parseAddCommand(text);
    const inFlow = user.telegramAction !== null && user.telegramStep !== "idle";

    if (!["/remove", "/modify", "/cancel"].includes(command) && addSearch === null && !inFlow) return false;

    // US 28 AC-03, US 29 AC-04, Telegram add items AC-04: cancelling changes nothing
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
    } else if (addSearch === "") {
        await startAddFlow(chatId, user);
    } else if (addSearch !== null) {
        await searchForItem(chatId, user, addSearch);
    } else if (user.telegramStep === "select_item") {
        await pickItem(chatId, user, text);
    } else if (user.telegramStep === "enter_quantity" && user.telegramAction === "modify") {
        await modifyItem(chatId, user, text);
    } else if (user.telegramStep === "enter_search" && user.telegramAction === "add") {
        await searchForItem(chatId, user, text);
    } else if (user.telegramStep === "select_result" && user.telegramAction === "add") {
        await pickSearchResult(chatId, user, text);
    } else if (user.telegramStep === "enter_quantity" && user.telegramAction === "add") {
        await addItem(chatId, user, text);
    } else {
        await resetFlow(user);
        return false;
    }

    return true;
}


module.exports = { handleListCommand, formatItemList, parseQuantityAndUnit, parseAddCommand, SEARCH_RESULTS_MAX };
