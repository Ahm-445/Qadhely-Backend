const router = require("express").Router();

const protect = require("../middleware/protected");
const {createGroup,getMyGroups,addGroupMember,generateGroupInvite,joinGroupByInvite,getGroupMembers} = require("../controllers/groupController");
const {getItems, addItem, updateItem, removeItem} = require("../controllers/itemController");


// US 05 — all group routes need a logged-in user
router.post("/", protect, createGroup);
router.get("/", protect, getMyGroups);
// US 06
router.post("/:groupId/members", protect, addGroupMember);
router.post("/:groupId/invite", protect, generateGroupInvite);
router.post("/join/:inviteToken", protect, joinGroupByInvite);
// US 30
router.get("/:groupId/members", protect, getGroupMembers);

// shopping list items; updating and removing notify the other members
router.get("/:groupId/items", protect, getItems);
router.post("/:groupId/items", protect, addItem);
router.patch("/:groupId/items/:itemId", protect, updateItem);
router.delete("/:groupId/items/:itemId", protect, removeItem);


module.exports = router;
