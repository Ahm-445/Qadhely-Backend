const router = require("express").Router();


const {loginSendOTP, loginRecieveOTP} = require("../controllers/authController");



router.post("/loginSendOTP", loginSendOTP);

router.post("/loginRecieveOTP", loginRecieveOTP);




module.exports = router;