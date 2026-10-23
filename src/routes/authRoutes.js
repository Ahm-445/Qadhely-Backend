const router = require("express").Router();


const {loginSendOTP, loginRecieveOTP} = require("../controllers/authController");
const {register, verifyRegistrationOtp} = require("../controllers/registerController");



router.post("/loginSendOTP", loginSendOTP);

router.post("/loginRecieveOTP", loginRecieveOTP);

router.post("/register", register);

router.post("/verify-otp", verifyRegistrationOtp);




module.exports = router;