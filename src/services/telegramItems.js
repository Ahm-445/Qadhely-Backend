const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { getCatalogItem } = require("./catalog");

const { ITEM_STATUSES } = ListItem;


// US 27 — Telegram chatbot: view the items of a shopping list.
//
// The webhook (US 25) finds the Qadhely user by their linked Telegram chat and calls
// buildItemsReply(user). Everything here is plain text (the messages are sent without a
// parse_mode), so a group or item name can never be read as formatting.

// Telegram refuses a message over 4096 characters; stay well under it
const MAX_MESSAGE_CHARS = 3800;
// a very long list is cut after this many messages (Telegram also rate-limits a chat)
const MAX_MESSAGES = 6;
// room kept in the last message for the "N more items" line
const MORE_NOTICE_RESERVE = 200;

const NAME_MAX = 150;
const STORE_MAX = 60;
const TEXT_MAX = 100;

const ADMIN_ROLES = [Group.ROLES.CREATOR, Group.ROLES.ADMIN];

const STATUS_LABELS = Object.freeze({
	[ITEM_STATUSES.PENDING]: "Pending",
	[ITEM_STATUSES.FOUND]: "Found",
	[ITEM_STATUSES.NOT_FOUND]: "Not found",
	[ITEM_STATUSES.REPLACED]: "Replaced",
});

const STATUS_ICONS = Object.freeze({
	[ITEM_STATUSES.PENDING]: "⏳",
	[ITEM_STATUSES.FOUND]: "✅",
	[ITEM_STATUSES.NOT_FOUND]: "❌",
	[ITEM_STATUSES.REPLACED]: "🔁",
});


// "/items" or "/items@QadhelyBot", nothing else
function isItemsCommand(text) {
	return typeof text === "string" && /^\/items(@\w+)?$/i.test(text.trim());
}


// "/group" or "/group@QadhelyBot": reopen the group picker (US 25's own group selection)
function isGroupCommand(text) {
	return typeof text === "string" && /^\/group(@\w+)?$/i.test(text.trim());
}


// one line of plain text: no control characters, no runs of spaces, not too long
function clean(value, max) {
	if (typeof value !== "string" && typeof value !== "number") return "";

	const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();

	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}


// the group, only if the user is (still) its creator or an admin; otherwise null
async function findAdminGroup(userId, groupId) {
	if (!groupId) return null;

	return Group.findOne({
		_id: groupId,
		members: { $elemMatch: { user: userId, role: { $in: ADMIN_ROLES } } },
	}).select("name").lean();
}


// ---------------------------------------------------------------------------------------------
// formatting

function productOf(item) {
	return item.catalogItemId ? getCatalogItem(item.catalogItemId) : null;
}


function itemName(item) {
	const product = productOf(item);

	if (product) {
		const name = clean(product.name_en, NAME_MAX);
		const brand = clean(product.brand_en, STORE_MAX);
		const size = clean(product.size_text, STORE_MAX);

		const parts = [name || clean(item.catalogItemId, NAME_MAX)];

		if (brand && !name.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
		if (size && !name.toLowerCase().includes(size.toLowerCase())) parts.push(size);

		return parts.join(" ");
	}

	// a custom request, or a catalog item that no longer exists
	return clean(item.customName, NAME_MAX) || clean(item.catalogItemId, NAME_MAX) || "Unnamed item";
}


function itemStore(item) {
	return clean(productOf(item)?.store, STORE_MAX) || clean(item.customStore, STORE_MAX);
}


function itemBlock(item, position, byId) {
	const status = STATUS_LABELS[item.status] ? item.status : ITEM_STATUSES.PENDING;

	const details = [`Qty: ${clean(item.quantity, 20)} ${clean(item.unit, 10)}`.trim()];

	const store = itemStore(item);

	if (store) details.push(`Store: ${store}`);

	details.push(`Status: ${STATUS_LABELS[status]}`);

	const lines = [
		`${position}. ${STATUS_ICONS[status]} ${itemName(item)}`,
		`   ${details.join(" | ")}`,
	];

	const replacementText = clean(item.replacementText, TEXT_MAX);

	if (status === ITEM_STATUSES.REPLACED) {
		const replacement = item.replacedBy ? byId.get(String(item.replacedBy)) : null;

		if (replacement) lines.push(`   Replaced by: ${itemName(replacement)}`);
		else if (replacementText) lines.push(`   Suggested replacement: ${replacementText}`);
	}
	else if (status === ITEM_STATUSES.NOT_FOUND && replacementText) {
		lines.push(`   Suggested replacement: ${replacementText}`);
	}

	if (item.replacementFor) {
		const old = byId.get(String(item.replacementFor));

		if (old) lines.push(`   Replacement for: ${itemName(old)}`);
	}

	return lines.join("\n");
}


// newest first, replaced items last: the same order as the app (GET /api/groups/:groupId/items)
function orderItems(items) {
	return [...items].sort((a, b) => {
		const last = (item) => (item.status === ITEM_STATUSES.REPLACED ? 1 : 0);

		return last(a) - last(b) || new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0);
	});
}


/** The Telegram messages (an array of plain-text strings, each within the limit) for a group's list. */
function formatItemMessages(groupName, items) {
	const name = clean(groupName, NAME_MAX) || "Shopping list";

	if (items.length === 0) {
		return [`${name}\n\nThis shopping list has no items yet.`];
	}

	const ordered = orderItems(items);
	const byId = new Map(ordered.map((item) => [String(item._id), item]));

	const counts = { pending: 0, found: 0, notFound: 0, replaced: 0 };

	for (const item of ordered) counts[STATUS_LABELS[item.status] ? item.status : ITEM_STATUSES.PENDING]++;

	const header = `${name}\n${ordered.length} item${ordered.length === 1 ? "" : "s"}: ${counts.pending} pending, ${counts.found} found, ${counts.notFound} not found, ${counts.replaced} replaced`;

	const blocks = ordered.map((item, index) => itemBlock(item, index + 1, byId));

	const messages = [];
	let current = header;
	let shown = 0;

	for (const block of blocks) {
		const isLastMessage = messages.length === MAX_MESSAGES - 1;
		const limit = isLastMessage ? MAX_MESSAGE_CHARS - MORE_NOTICE_RESERVE : MAX_MESSAGE_CHARS;

		if (current.length + 2 + block.length > limit) {
			if (isLastMessage) break;

			messages.push(current);
			current = block;
		}
		else {
			current = `${current}\n\n${block}`;
		}

		shown++;
	}

	if (shown < blocks.length) {
		const more = blocks.length - shown;

		current += `\n\n...and ${more} more item${more === 1 ? "" : "s"} not shown. Open the Qadhely app to see the full list.`;
	}

	messages.push(current);

	return messages;
}


// ---------------------------------------------------------------------------------------------
// the /items request

/**
 * What to send for "/items" from a linked user:
 *   { kind: "items", messages }  the selected group's list
 *   { kind: "choose", text }     no usable selected group: send `text`, then US 25's group picker
 *
 * The creator/admin role is checked again here on every request, so a user who was removed or
 * demoted since choosing the group gets nothing. Saving, clearing and auto-selecting the group
 * is US 25's job (showAdminGroups in the webhook), which the caller runs for "choose".
 */
async function buildItemsReply(user) {
	const group = await findAdminGroup(user._id, user.selectedGroupId);

	if (!group) {
		return {
			kind: "choose",
			text: user.selectedGroupId
				? "You can no longer manage the list you selected."
				: "Please select a shopping list first.",
		};
	}

	const items = await ListItem.find({ group: group._id }).lean();

	return { kind: "items", messages: formatItemMessages(group.name, items) };
}


module.exports = {
	isItemsCommand,
	isGroupCommand,
	buildItemsReply,
	formatItemMessages,
	findAdminGroup,
	orderItems,
	MAX_MESSAGE_CHARS,
	MAX_MESSAGES,
};
