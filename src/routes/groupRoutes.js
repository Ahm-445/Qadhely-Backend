const router = require("express").Router();

const protect = require("../middleware/protected");
const {createGroup,getMyGroups,addGroupMember,generateGroupInvite,joinGroupByInvite,getGroupMembers} = require("../controllers/groupController");
const { addListItem, updateListItem } = require("../controllers/listItemController");
const { getListItems, removeListItem } = require("../controllers/listItemRemoveController");
const { deleteGroup } = require("../controllers/groupDeleteController");
const { setItemStatus } = require("../controllers/itemStatusController");
const { replaceListItem } = require("../controllers/itemReplaceController");


// US 05 — all group routes need a logged-in user
router.post("/", protect, createGroup);
router.get("/", protect, getMyGroups);
// US 08 — the Group Creator deletes the group
router.delete("/:groupId", protect, deleteGroup);
// US 06
router.post("/:groupId/members", protect, addGroupMember);
router.post("/:groupId/invite", protect, generateGroupInvite);
router.post("/join/:inviteToken", protect, joinGroupByInvite);
// US 30
router.get("/:groupId/members", protect, getGroupMembers);
// US 12 — add an item to the group's shopping list
router.post("/:groupId/items", protect, addListItem);
// US 13 — read the list (for the app) and remove an item from it
router.get("/:groupId/items", protect, getListItems);
router.delete("/:groupId/items/:itemId", protect, removeListItem);
// US 14 — modify an item's quantity and unit
router.patch("/:groupId/items/:itemId", protect, updateListItem);
// US 16 — any member marks an item found / not found (with an optional replacement suggestion)
router.patch("/:groupId/items/:itemId/status", protect, setItemStatus);
// US 22 — an admin replaces a not-found item with an item from the catalog
router.post("/:groupId/items/:itemId/replace", protect, replaceListItem);

module.exports = router;
