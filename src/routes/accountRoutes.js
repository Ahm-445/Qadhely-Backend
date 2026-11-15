const router = require("express").Router();

const protect = require("../middleware/protected");
const { sendDeleteAccountOtp, confirmDeleteAccount } = require("../controllers/accountController");


// US 04 — Delete Account (logged-in users only)
router.post("/delete/send-otp", protect, sendDeleteAccountOtp);
router.post("/delete/verify", protect, confirmDeleteAccount);


module.exports = router;
