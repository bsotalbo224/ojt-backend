const express = require("express");
const router = express.Router();

const messageController = require("../controllers/messageController");
const { requireAuth } = require("../middleware/authMiddleware");

router.post("/send", requireAuth, messageController.sendMessage);
router.get("/conversation/:userId", requireAuth, messageController.getConversation);
router.put("/read/:userId", requireAuth, messageController.markAsRead);
router.get("/conversations", requireAuth, messageController.getConversations);

module.exports = router;