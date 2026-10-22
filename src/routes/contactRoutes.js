const router = require("express").Router();

const protect = require("../middleware/protected");
const { matchContacts } = require("../controllers/contactController");


// US 05 — find which phone contacts are registered users
router.post("/match", protect, matchContacts);


module.exports = router;
