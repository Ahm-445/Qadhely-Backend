const router = require("express").Router();

const protect = require("../middleware/protected");
const {addDeviceToken, removeDeviceToken} = require("../controllers/devicesController");


// push tokens of the phones this user is logged in on
// both routes need a logged-in user: a token is only ever linked to its own user
router.post("/", protect, addDeviceToken);

router.delete("/:pushToken", protect, removeDeviceToken);


module.exports = router;
