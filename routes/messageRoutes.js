const express = require("express");
const router = express.Router();

const messageController = require("../controllers/messageController");
const { requireAuth } = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

// Consultation Contacts
router.route("/contacts")
  .get(requireAuth, messageController.getConsultationContacts);

// Private Conversation
router.route("/private")
  .post(requireAuth, messageController.getOrCreatePrivateConversation);

// Conversations
router.route("/conversations")
  .get(requireAuth, messageController.getConversations);

router.route("/conversations/:conversationId/messages")
  .get(requireAuth, messageController.getConversation);

router.route("/conversations/:conversationId/read")
  .put(requireAuth, messageController.markAsRead);

// Messages
router.route("/messages")
  .post(requireAuth, upload.array("attachments", 10), messageController.sendMessage);

// Reactions
router.route("/messages/:messageId/reactions")
  .get(requireAuth, messageController.getMessageReactions)
  .put(requireAuth, messageController.toggleReaction)
  .delete(requireAuth, messageController.removeReaction);


module.exports = router;