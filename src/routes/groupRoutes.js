const router = require("express").Router();

const protect = require("../middleware/protected");
const { createGroup, getMyGroups } = require("../controllers/groupController");


// US 05 — all group routes need a logged-in user
router.post("/", protect, createGroup);
router.get("/", protect, getMyGroups);


module.exports = router;
