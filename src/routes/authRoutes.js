const router = require("express").Router();


const {loginSendOTP, loginRecieveOTP} = require("../controllers/authController");
const {register} = require("../controllers/registerController");



router.post("/loginSendOTP", loginSendOTP);

router.post("/loginRecieveOTP", loginRecieveOTP);

router.post("/register", register);




module.exports = router;