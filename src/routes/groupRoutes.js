const router = require("express").Router();

const protect = require("../middleware/protected");
const {createGroup,getMyGroups,addGroupMember,generateGroupInvite,joinGroupByInvite} = require("../controllers/groupController");


// US 05 — all group routes need a logged-in user
router.post("/", protect, createGroup);
router.get("/", protect, getMyGroups);
// US 06
router.post("/:groupId/members", protect, addGroupMember);
router.post("/:groupId/invite", protect, generateGroupInvite);
router.post("/join/:inviteToken", protect, joinGroupByInvite);


module.exports = router;
