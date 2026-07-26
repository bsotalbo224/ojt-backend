const MessageModel = require("../models/messageModel");
const { sendNotification } = require("../services/notificationServices");
const { io } = require("../server");

const MAX_MESSAGE_LENGTH = 5000;
const ALLOWED_MESSAGE_TYPES = ["text", "file", "system"];
const ALLOWED_REACTION_CODES = ["like", "love", "laugh", "wow", "sad", "angry"];
const ALLOWED_CONSULTATION_ROLES = ["student", "coordinator", "admin"];
const KNOWN_STATUS_CODES = new Set([400, 401, 403, 404, 409]);

const MENTION_PRIORITY = { everyone: 1, student: 2, coordinator: 2, user: 3 };

const MENTION_MESSAGE_BUILDERS = {
  user: (name) => `${name} mentioned you in a conversation.`,
  student: (name) => `${name} mentioned @Student`,
  coordinator: (name) => `${name} mentioned @Coordinator`,
  everyone: (name) => `${name} mentioned @everyone`
};

const REACTION_EVENT_BY_ACTION = {
  added: "reaction_added",
  updated: "reaction_updated",
  removed: "reaction_removed"
};

// Helpers
const isValidId = (value) =>
  Number.isInteger(value) && value > 0;

const isValidOptionalId = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value !== "number" && typeof value !== "string") return false;
  return isValidId(Number(value));
};

const isValidMessageType = (value) =>
  value === undefined || value === null || ALLOWED_MESSAGE_TYPES.includes(value);

const isValidReactionCode = (value) =>
  typeof value === "string" && ALLOWED_REACTION_CODES.includes(value);

const isValidConsultationRole = (value) =>
  typeof value === "string" && ALLOWED_CONSULTATION_ROLES.includes(value);

const resolveAcademicYearId = (req) => {
  const raw = req.headers["x-academic-year-id"] || req.user?.academic_year_id;
  const parsed = Number(raw);
  return isValidId(parsed) ? parsed : null;
};

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const ok = (res, payload) => res.json({ success: true, ...payload });

const respondToModelError = (res, err, context) => {
  console.error(context, err);

  if (KNOWN_STATUS_CODES.has(err?.statusCode)) {
    return fail(res, err.statusCode, err.message);
  }

  return fail(res, 500, "Server error");
};

const buildLink = (role, conversationId) => {
  if (role === "student") return `/student/messages?conversation=${conversationId}`;
  if (role === "coordinator") return `/coordinator/messages?conversation=${conversationId}`;
  if (role === "admin") return `/admin/messages?conversation=${conversationId}`;
  return `/messages?conversation=${conversationId}`;
};

// Attachment Transform
const sanitizeAttachment = (file) => ({
  attachment_name: file.originalname,
  attachment_url: file.path,
  attachment_type: file.mimetype,
  attachment_size: Number(file.size)
});

// Attachment Transform
const sanitizeAttachments = (files) => (Array.isArray(files) ? files : []).map(sanitizeAttachment);

const emitToConversation = (conversationId, event, payload) => {
  if (!conversationId || !event) return;
  io.to(`conversation_${conversationId}`).emit(event, payload);
};

const emitReactionUpdate = (conversationId, event, messageId, userId, reactionCode, summary) => {
  emitToConversation(conversationId, event, {
    message_id: messageId,
    user_id: userId,
    reaction_code: reactionCode,
    summary
  });
};

const parseAuthorizedRequest = (req, res, conversationId) => {
  const userId = Number(req.user?.user_id);
  const academicYearId = resolveAcademicYearId(req);

  if (!isValidId(userId) || !isValidId(conversationId)) {
    fail(res, 400, "Invalid conversation ID");
    return null;
  }

  if (!academicYearId) {
    fail(res, 400, "Invalid or missing academic year");
    return null;
  }

  return { userId, conversationId, academicYearId };
};

const authorizeConversation = (req, res) =>
  parseAuthorizedRequest(req, res, Number(req.params.conversationId));

const parseReactionRequest = (req, res) => {
  const userId = Number(req.user?.user_id);
  const messageId = Number(req.params.messageId);
  const academicYearId = resolveAcademicYearId(req);

  if (!isValidId(userId)) {
    fail(res, 400, "Invalid user ID");
    return null;
  }

  if (!isValidId(messageId)) {
    fail(res, 400, "Invalid message ID");
    return null;
  }

  if (!academicYearId) {
    fail(res, 400, "Invalid or missing academic year");
    return null;
  }

  return { userId, messageId, academicYearId };
};


// Notifications
const buildNotificationPayload = ({ userId, type, title, message, role, conversationId, academicYearId }) => ({
  user_id: userId,
  type,
  title,
  message,
  link: buildLink(role, conversationId),
  academic_year_id: academicYearId
});

const dispatchNotification = async (event, payload) => {
  io.to(`user_${payload.user_id}`).emit(event, payload);
  await sendNotification(payload);
};

const buildMentionRecipients = (mentions, members, senderId) => {
  const recipients = new Map();

  const addRecipient = (userId, type) => {
    if (!userId || userId === senderId) return;
    const existingType = recipients.get(userId);
    if (!existingType || MENTION_PRIORITY[type] > MENTION_PRIORITY[existingType]) {
      recipients.set(userId, type);
    }
  };

  for (const mention of mentions) {
    switch (mention.mention_type) {
      case "user":
        addRecipient(mention.mentioned_user_id, "user");
        break;
      case "everyone":
        for (const member of members) addRecipient(member.user_id, "everyone");
        break;
      case "student":
        for (const member of members) {
          if ((member.role || "").toLowerCase() === "student") {
            addRecipient(member.user_id, "student");
          }
        }
        break;
      case "coordinator":
        for (const member of members) {
          if ((member.role || "").toLowerCase() === "coordinator") {
            addRecipient(member.user_id, "coordinator");
          }
        }
        break;
      default:
        break;
    }
  }

  return recipients;
};

const notifyMentions = async (recipients, memberRoleMap, senderName, conversationId, academicYearId) => {
  if (recipients.size === 0) return;

  await Promise.all([...recipients.entries()].map(([userId, type]) => {
    const payload = buildNotificationPayload({
      userId,
      type: "mention",
      title: "Mentioned You",
      message: MENTION_MESSAGE_BUILDERS[type](senderName),
      role: memberRoleMap.get(userId),
      conversationId,
      academicYearId
    });

    return dispatchNotification("mention_notification", payload);
  }));
};

const notifyNewMessage = async (members, senderId, senderName, academicYearId, conversationId, excludeUserIds) => {
  const recipients = members.filter(
    (member) => member.user_id !== senderId && !excludeUserIds.has(member.user_id)
  );

  if (recipients.length === 0) return;

  await Promise.all(recipients.map((member) => {
    const payload = buildNotificationPayload({
      userId: member.user_id,
      type: "message",
      title: "New Message",
      message: `${senderName} sent you a message`,
      role: member.role,
      conversationId,
      academicYearId
    });

    return dispatchNotification("message_notification", payload);
  }));
};


// Send Message
exports.sendMessage = async (req, res) => {
  try {

    const senderId = Number(req.user?.user_id);
    const academicYearId = resolveAcademicYearId(req);

    if (!isValidId(senderId)) {
      return fail(res, 400, "Invalid sender ID");
    }

    if (!academicYearId) {
      return fail(res, 400, "Invalid or missing academic year");
    }

    const {
      receiver_id,
      conversation_id,
      message,
      message_type,
      related_log_id,
      related_narrative_id,
      reply_to_message_id
    } = req.body;

    if (!isValidOptionalId(related_log_id) || !isValidOptionalId(related_narrative_id)) {
      return fail(res, 400, "Invalid related reference ID");
    }

    if (!isValidOptionalId(reply_to_message_id)) {
      return fail(res, 400, "Invalid reply_to_message_id");
    }

    if (!isValidMessageType(message_type)) {
      return fail(res, 400, "Invalid message type");
    }

    // Multer's upload.array("attachments", 10) populates req.files.
    const attachments = sanitizeAttachments(req.files);

    if (!receiver_id && !conversation_id) {
      return fail(res, 400, "receiver_id or conversation_id is required");
    }

    const trimmedMessage = typeof message === "string" ? message.trim() : "";
    const hasText = trimmedMessage !== "";
    const hasAttachment = attachments.length > 0;

    if (!hasText && !hasAttachment) {
      return fail(res, 400, "Message text or attachment is required");
    }

    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return fail(res, 400, `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
    }

    let conversationId;

    if (conversation_id !== undefined) {
      conversationId = Number(conversation_id);

      if (!isValidId(conversationId)) {
        return fail(res, 400, "Invalid conversation ID");
      }

      const authorized = await MessageModel.isMember(conversationId, senderId, academicYearId);

      if (!authorized) {
        return fail(res, 403, "You are not a member of this conversation");
      }

    } else {
      const receiverId = Number(receiver_id);

      if (!isValidId(receiverId)) {
        return fail(res, 400, "Invalid receiver ID");
      }

      if (receiverId === senderId) {
        return fail(res, 400, "Cannot send message to yourself");
      }

      conversationId = await MessageModel.getOrCreatePrivateConversation(
        senderId,
        receiverId,
        academicYearId
      );
    }

    const insertResult = await MessageModel.sendMessage(
      senderId,
      conversationId,
      trimmedMessage,
      {
        messageType: message_type,
        relatedLogId: related_log_id,
        relatedNarrativeId: related_narrative_id,
        academicYearId,
        attachments,
        replyToMessageId:
          reply_to_message_id == null
            ? null
            : Number(reply_to_message_id)
      }
    );

    const enrichedMessage = insertResult.message;

    emitToConversation(conversationId, "receive_message", enrichedMessage);

    const senderName = `${enrichedMessage.f_name} ${enrichedMessage.l_name}`.trim() || "Someone";

    const members = await MessageModel.getConversationMembers(conversationId, academicYearId);
    const memberRoleMap = new Map(members.map((member) => [member.user_id, member.role]));

    const mentionRecipients = buildMentionRecipients(enrichedMessage.mentions, members, senderId);

    await notifyMentions(mentionRecipients, memberRoleMap, senderName, conversationId, academicYearId);
    await notifyNewMessage(members, senderId, senderName, academicYearId, conversationId, new Set(mentionRecipients.keys()));

    return ok(res, { message: "Message sent successfully", data: enrichedMessage });

  } catch (error) {

    return respondToModelError(res, error, "Send message error:");

  }
};


// Conversation
exports.getConversation = async (req, res) => {
  try {

    const auth = authorizeConversation(req, res);
    if (!auth) return;

    const { userId, conversationId, academicYearId } = auth;

    await MessageModel.markConversationRead(conversationId, userId, academicYearId);

    const messages = await MessageModel.getMessagesByConversation(
      conversationId,
      userId,
      academicYearId
    );

    return ok(res, { messages });

  } catch (error) {

    return respondToModelError(res, error, "Get conversation error:");

  }
};


// Read
exports.markAsRead = async (req, res) => {
  try {

    const auth = authorizeConversation(req, res);
    if (!auth) return;

    const { userId, conversationId, academicYearId } = auth;

    await MessageModel.markConversationRead(conversationId, userId, academicYearId);

    return ok(res, {});

  } catch (error) {

    return respondToModelError(res, error, "Mark as read error:");

  }
};


// Reactions
exports.toggleReaction = async (req, res) => {
  try {

    const auth = parseReactionRequest(req, res);
    if (!auth) return;

    const { userId, messageId, academicYearId } = auth;
    const { reaction_code } = req.body;

    if (!isValidReactionCode(reaction_code)) {
      return fail(res, 400, `reaction_code must be one of: ${ALLOWED_REACTION_CODES.join(", ")}`);
    }

    const result = await MessageModel.toggleReaction(messageId, userId, reaction_code, academicYearId);
    const conversationId = await MessageModel.getConversationIdByMessage(messageId, academicYearId);

    emitReactionUpdate(
      conversationId,
      REACTION_EVENT_BY_ACTION[result.action],
      messageId,
      userId,
      result.reaction_code,
      result.summary
    );

    return ok(res, {
      action: result.action,
      reaction_code: result.reaction_code,
      summary: result.summary
    });

  } catch (error) {

    return respondToModelError(res, error, "Toggle reaction error:");

  }
};

exports.removeReaction = async (req, res) => {
  try {

    const auth = parseReactionRequest(req, res);
    if (!auth) return;

    const { userId, messageId, academicYearId } = auth;

    const summary = await MessageModel.removeReaction(messageId, userId, academicYearId);
    const conversationId = await MessageModel.getConversationIdByMessage(messageId, academicYearId);

    emitReactionUpdate(conversationId, "reaction_removed", messageId, userId, null, summary);

    return ok(res, { summary });

  } catch (error) {

    return respondToModelError(res, error, "Remove reaction error:");

  }
};

exports.getMessageReactions = async (req, res) => {
  try {

    const auth = parseReactionRequest(req, res);
    if (!auth) return;

    const { userId, messageId, academicYearId } = auth;

    const summary = await MessageModel.getMessageReactions(messageId, userId, academicYearId);

    return ok(res, { summary });

  } catch (error) {

    return respondToModelError(res, error, "Get message reactions error:");

  }
};


// Conversation List
exports.getConversations = async (req, res) => {
  try {

    const userId = Number(req.user?.user_id);

    if (!isValidId(userId)) {
      return fail(res, 400, "Invalid user ID");
    }

    const academicYearId = resolveAcademicYearId(req);

    if (!academicYearId) {
      return fail(res, 400, "Invalid or missing academic year");
    }

    const conversations = await MessageModel.getConversations(userId, academicYearId);

    return ok(res, { conversations });

  } catch (error) {

    return respondToModelError(res, error, "Get conversations error:");

  }
};


// Consultation Contacts
exports.getConsultationContacts = async (req, res) => {
  try {

    const userId = Number(req.user?.user_id);
    const role = req.user?.role;
    const academicYearId = resolveAcademicYearId(req);

    if (!isValidId(userId)) {
      return fail(res, 400, "Invalid user ID");
    }

    if (!isValidConsultationRole(role)) {
      return fail(res, 400, `role must be one of: ${ALLOWED_CONSULTATION_ROLES.join(", ")}`);
    }

    if (!academicYearId) {
      return fail(res, 400, "Invalid or missing academic year");
    }

    const contacts = await MessageModel.getConsultationContacts(userId, role, academicYearId);

    return ok(res, { contacts });

  } catch (error) {

    return respondToModelError(res, error, "Get consultation contacts error:");

  }
};


// Private Conversation
exports.getOrCreatePrivateConversation = async (req, res) => {
  try {

    const senderId = Number(req.user?.user_id);
    const receiverId = Number(req.body.user_id);
    const academicYearId = resolveAcademicYearId(req);

    if (!isValidId(senderId)) {
      return fail(res, 400, "Invalid sender ID");
    }

    if (!isValidId(receiverId)) {
      return fail(res, 400, "Invalid receiver ID");
    }

    if (!academicYearId) {
      return fail(res, 400, "Invalid or missing academic year");
    }

    if (receiverId === senderId) {
      return fail(res, 400, "Cannot start a conversation with yourself");
    }

    const conversationId = await MessageModel.getOrCreatePrivateConversation(
      senderId,
      receiverId,
      academicYearId
    );

    return ok(res, { conversation_id: conversationId });

  } catch (error) {

    return respondToModelError(res, error, "Get or create private conversation error:");

  }
};