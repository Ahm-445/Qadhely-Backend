const router = require("express").Router();

const protect = require("../middleware/protected");
const { searchCatalogItems } = require("../controllers/catalogController");


// US 12 — search the product catalog (needs a logged-in user)
router.get("/search", protect, searchCatalogItems);

module.exports = router;
