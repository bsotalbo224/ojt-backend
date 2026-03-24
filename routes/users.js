const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/authMiddleware");
const usersController = require("../controllers/usersController");

router.put(
  "/change-password",
  requireAuth,
  usersController.changePassword
);

module.exports = router;