const router = require("express").Router();

const protect = require("../middleware/protected");
const {createGroup,getMyGroups,addGroupMember,generateGroupInvite,joinGroupByInvite,getGroupMembers} = require("../controllers/groupController");
const { addListItem } = require("../controllers/listItemController");
const { getListItems, removeListItem } = require("../controllers/listItemRemoveController");


// US 05 — all group routes need a logged-in user
router.post("/", protect, createGroup);
router.get("/", protect, getMyGroups);
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

module.exports = router;
