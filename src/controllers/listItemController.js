const mongoose = require("mongoose");

const Group = require("../models/Group");
const ListItem = require("../models/ListItem");
const { notifyItemsAdded } = require("../services/pushNotifications");
const { UNITS, CATALOG_ITEM_ID_PATTERN, CATALOG_ITEM_ID_MAX } = ListItem;


// shape sent to the app
function toListItemResponse(item, groupId) {
	return {
		id: String(item._id),
		groupId: String(groupId),
		catalogItemId: item.catalogItemId ?? null,
		quantity: item.quantity,
		unit: item.unit,
		addedBy: String(item.addedBy),
		customName: item.customName,
		customImage: item.customImage,
		customStore: item.customStore,
		createdAt: item.createdAt,
	};
}


// POST /api/groups/:groupId/items
// body: { catalogItemId: string, quantity: number, unit?: "kg" | "piece" | "box" }
// US 12 AC-01: stores the catalog item on the group's list.
// US 12 AC-02: only the Group Creator and admins can add; everyone else gets 403.
// US 12 AC-03: a whole number unless the unit is kg; the unit is one of the three.
// US 12 AC-04: the group has to exist.
const addListItem = async (req, res) => {
	try {

		const { groupId } = req.params;
		const userId = String(req.user.id);
		const { catalogItemId, quantity, unit = UNITS.PIECE } = req.body || {};

		if (!mongoose.isValidObjectId(groupId)) {
			return res.status(400).json({ error: "Invalid group ID." });
		}

		const group = await Group.findById(groupId).select("members");

		if (!group) {
			return res.status(404).json({ error: "Group not found." });
		}

		// US 12 AC-02: the same rule as the Add Items tab
		const role = group.roleOf(userId);

		if (!role) {
			return res.status(403).json({ error: "You are not a member of this group." });
		}

		if (!Group.isAdminRole(role)) {
			return res.status(403).json({ error: "Only group admins can add items." });
		}

		// the catalog teammate owns the catalog; here the id only has to be well formed
		const catalogId = typeof catalogItemId === "string" ? catalogItemId.trim() : "";

		if (!CATALOG_ITEM_ID_PATTERN.test(catalogId) || catalogId.length > CATALOG_ITEM_ID_MAX) {
			return res.status(400).json({ error: "A valid catalog item is required." });
		}

		if (!Object.values(UNITS).includes(unit)) {
			return res.status(400).json({ error: `Unit must be one of ${Object.values(UNITS).join(", ")}.` });
		}

		if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
			return res.status(400).json({ error: "Enter a quantity of 0 or more." });
		}

		// US 12 AC-03: a decimal point is allowed only by weight
		if (unit !== UNITS.KG && !Number.isInteger(quantity)) {
			return res.status(400).json({ error: "Quantity must be a whole number unless the unit is kg." });
		}

		const item = await ListItem.create({
			group: group._id,
			catalogItemId: catalogId,
			quantity,
			unit,
			addedBy: userId,
		});

		// US 18: tell the other members if this is the first item in over 5 minutes. Started only now
		// that the item is saved, and not awaited: it never throws, and a slow or failing push
		// service must not delay or fail this response.
		notifyItemsAdded(group._id, userId);

		return res.status(201).json({
			message: "Item added",
			item: toListItemResponse(item, group._id),
		});

	}
	catch (err) {
		console.log(err);

		if (err.name === "ValidationError") {
			return res.status(400).json({ error: err.message });
		}

		res.status(500).json({ error: "Failed to add the item." });
	}
};


module.exports = { addListItem };
