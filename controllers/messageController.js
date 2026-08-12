const MessageModel = require("../models/messageModel");
const { io } = require("../server");

const MAX_MESSAGE_LENGTH = 5000;
const ALLOWED_MESSAGE_TYPES = ["text", "file", "system"];
const ALLOWED_REACTION_CODES = ["like", "love", "laugh", "wow", "sad", "angry"];
const ALLOWED_CONSULTATION_ROLES = ["student", "coordinator", "admin"];
const KNOWN_STATUS_CODES = new Set([400, 401, 403, 404, 409]);

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

const CONVERSATION_UPDATED_EVENT = "conversation_updated";

// Keeps the sidebar/ConversationList in sync in real time, separately from
// receive_message (which only reaches clients that have joined this
// specific conversation's room via join_conversation -- something
// MessagesPage only does once a conversation is selected). Emitted to each
// member's own "user_<id>" room instead, which is joined once on mount
// regardless of what's currently selected, so this reaches recipients even
// for a conversation they haven't opened, or one that's brand new to them.
//
// The conversation-list portion of the payload (is_group/name/member_count,
// or the other participant's user_id/f_name/l_name/photo/role, plus
// unread_count) comes from MessageModel.getConversationForMember(), which
// reuses getConversations()'s own query rather than resolving "the other
// participant" by hand here -- so a live update is guaranteed to match
// exactly what that member's own next page refresh would show. Only the
// message-specific fields (what was just sent) come from enrichedMessage.
const emitConversationUpdated = async (members, enrichedMessage, conversationId, academicYearId) => {
  if (!Array.isArray(members) || members.length === 0) return;

  await Promise.all(members.map(async (member) => {
    const conversationView = await MessageModel.getConversationForMember(
      member.user_id,
      conversationId,
      academicYearId
    );

    // Shouldn't happen for a member who was just confirmed to belong to
    // this conversation, but skip rather than emit an incomplete payload.
    if (!conversationView) return;

    const payload = {
      ...conversationView,
      message_id: enrichedMessage.message_id,
      message: enrichedMessage.message,
      attachments: enrichedMessage.attachments,
      sender_id: enrichedMessage.sender_id,
      sent_at: enrichedMessage.sent_at ?? enrichedMessage.created_at,
      created_at: enrichedMessage.created_at
    };

    io.to(`user_${member.user_id}`).emit(CONVERSATION_UPDATED_EVENT, payload);
  }));
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


// Send Message
//
// NOTE: notification creation for a sent message (currently: the
// "You were mentioned" notification, and only that — a plain message no
// longer creates a normal-notification-system record) is owned entirely
// by MessageModel.sendMessage() -> sendMessageNotifications(). This
// handler previously ALSO independently re-fetched members, recomputed
// mentions, and called its own notifyMentions()/notifyNewMessage(), which
// meant every message send created normal `notifications` rows (and
// `notification:new` events) TWICE — once from the model, once from here
// — with the plain "New Message"/"New message from X" duplicate being
// exactly what caused ordinary consultation chat messages to appear in
// the TopBar notification bell. That duplicate path (notifyMentions,
// notifyNewMessage, dispatchNotification, buildNotificationPayload,
// buildMentionRecipients, buildLink, and the message_notification /
// mention_notification socket emits nothing in the frontend was listening
// for anyway) has been removed. Real-time chat delivery itself is
// unaffected: emitToConversation(..., "receive_message", ...) below is
// unchanged and still fires exactly as before.
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
    await emitConversationUpdated(insertResult.members, enrichedMessage, conversationId, academicYearId);

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