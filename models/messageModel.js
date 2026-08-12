const db = require("../config/db");
const {
  sendNotification,
  NotificationTypes,
} = require("../services/notificationService");

// Helpers
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = "ForbiddenError";
    this.statusCode = 403;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
  }
}

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isNullableOrPositiveInt = (value) => value === null || value === undefined || isPositiveInt(value);

const toValidUniqueIds = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  return [...new Set(ids.filter(isPositiveInt))];
};

const ALLOWED_MESSAGE_TYPES = new Set(["text", "file", "system"]);
const ALLOWED_REACTION_CODES = new Set(["like", "love", "laugh", "wow", "sad", "angry"]);
const ALLOWED_CONSULTATION_ROLES = new Set(["student", "coordinator", "admin"]);

const MAX_MENTION_WORDS = 5;
const MENTION_WORD = "[A-Za-z]+(?:[-'.][A-Za-z]+)*\\.?";
const MENTION_TOKEN_REGEX = new RegExp(
  `@(${MENTION_WORD}(?:\\s+${MENTION_WORD}){0,${MAX_MENTION_WORDS - 1}})`,
  "g"
);

// Attachment limits
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const MAX_ATTACHMENT_URL_LENGTH = 2048; 
const normalizeMentionText = (text) =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

const groupRowsByKey = (rows, key) => {
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row[key])) {
      grouped.set(row[key], []);
    }
    grouped.get(row[key]).push(row);
  }

  return grouped;
};

const buildMentionCandidates = (members) => {
  const candidates = new Map();

  candidates.set("everyone", { type: "everyone", userId: null });
  candidates.set("student", { type: "student", userId: null });
  candidates.set("coordinator", { type: "coordinator", userId: null });

  for (const member of members) {
    const fullName = normalizeMentionText(
      `${member.f_name ?? ""} ${member.l_name ?? ""}`
    );

    if (fullName) {
      candidates.set(fullName, { type: "user", userId: member.user_id });
    }
  }

  return candidates;
};

const extractMentionsFromMessage = (message, members) => {
  if (typeof message !== "string" || !message.includes("@")) {
    return [];
  }

  if (!Array.isArray(members) || members.length === 0) {
    return [];
  }

  const candidates = buildMentionCandidates(members);
  const mentions = [];
  const seen = new Set();

  let match;
  MENTION_TOKEN_REGEX.lastIndex = 0;

  while ((match = MENTION_TOKEN_REGEX.exec(message)) !== null) {
    const words = match[1].split(/\s+/).slice(0, MAX_MENTION_WORDS);

    for (let len = words.length; len >= 1; len--) {
      const candidateText = normalizeMentionText(words.slice(0, len).join(" "));
      const resolved = candidates.get(candidateText);

      if (resolved) {
        const key = resolved.type === "user" ? `user_${resolved.userId}` : resolved.type;

        if (!seen.has(key)) {
          seen.add(key);
          mentions.push({ type: resolved.type, userId: resolved.userId });
        }
        break;
      }
    }
  }

  return mentions;
};

const fetchConversationMembers = async (conn, conversationId, academicYearId) => {
  const [rows] = await conn.execute(`
    SELECT u.user_id, u.f_name, u.l_name, u.role
    FROM conversation_members cm
    JOIN conversations c
      ON c.conversation_id = cm.conversation_id
    JOIN users u
      ON u.user_id = cm.user_id
    WHERE cm.conversation_id = ?
    AND c.academic_year_id = ?
  `, [conversationId, academicYearId]);

  return rows;
};

const insertMentionRecords = async (conn, messageId, mentions) => {
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return;
  }

  const values = mentions.map((m) => [messageId, m.userId ?? null, m.type]);

  await conn.query(
    `INSERT IGNORE INTO message_mentions (message_id, mentioned_user_id, mention_type)
     VALUES ?`,
    [values]
  );
};

const fetchMentionsForMessages = async (messageIds) => {
  const validIds = toValidUniqueIds(messageIds);

  if (validIds.length === 0) {
    return new Map();
  }

  const [rows] = await db.query(`
    SELECT
      mm.message_id,
      mm.mention_id,
      mm.mention_type,
      mm.mentioned_user_id,
      u.f_name,
      u.l_name,
      u.photo,
      u.role
    FROM message_mentions mm
    LEFT JOIN users u
      ON u.user_id = mm.mentioned_user_id
    WHERE mm.message_id IN (?)
    ORDER BY mm.message_id ASC, mm.mention_id ASC
  `, [validIds]);

  return groupRowsByKey(rows, "message_id");
};

// Attachments
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyStringWithinLength = (value, maxLength) =>
  typeof value === "string" && value.trim() !== "" && value.length <= maxLength;

const validateAttachment = (attachment) => {
  if (!isPlainObject(attachment)) {
    throw new ValidationError("Each attachment must be an object");
  }

  const { attachment_name, attachment_url, attachment_type, attachment_size } = attachment;

  if (!isNonEmptyStringWithinLength(attachment_name, MAX_ATTACHMENT_NAME_LENGTH)) {
    throw new ValidationError(
      `attachment_name is required and must be a string of at most ${MAX_ATTACHMENT_NAME_LENGTH} characters`
    );
  }

  if (!isNonEmptyStringWithinLength(attachment_url, MAX_ATTACHMENT_URL_LENGTH)) {
    throw new ValidationError(
      `attachment_url is required and must be a string of at most ${MAX_ATTACHMENT_URL_LENGTH} characters`
    );
  }

  if (typeof attachment_type !== "string" || attachment_type.trim() === "") {
    throw new ValidationError("attachment_type is required and must be a non-empty string");
  }

  if (!isPositiveInt(attachment_size)) {
    throw new ValidationError("attachment_size is required and must be a positive integer");
  }
};

const normalizeAttachment = (attachment) => ({
  attachment_name: attachment.attachment_name.trim(),
  attachment_url: attachment.attachment_url.trim(),
  attachment_type: attachment.attachment_type.trim(),
  attachment_size: attachment.attachment_size
});

const buildAttachmentDedupeKey = (attachment) =>
  `${attachment.attachment_name}\u0000${attachment.attachment_url}\u0000${attachment.attachment_size}`;

const prepareAttachments = (attachments) => {
  if (!Array.isArray(attachments)) {
    throw new ValidationError("attachments must be an array");
  }

  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ValidationError(`A message cannot have more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
  }

  const seen = new Set();
  const prepared = [];

  for (const attachment of attachments) {
    if (attachment === null || attachment === undefined) {
      throw new ValidationError("attachments cannot contain null or undefined entries");
    }

    validateAttachment(attachment);
    const normalized = normalizeAttachment(attachment);

    const dedupeKey = buildAttachmentDedupeKey(normalized);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    prepared.push(normalized);
  }

  return prepared;
};

const saveMessageAttachments = async (conn, messageId, attachments) => {
  const preparedAttachments = prepareAttachments(attachments);

  if (preparedAttachments.length === 0) {
    return;
  }

  const values = preparedAttachments.map((attachment) => [
    messageId,
    attachment.attachment_name,
    attachment.attachment_url,
    attachment.attachment_type,
    attachment.attachment_size
  ]);

  await conn.query(
    `INSERT INTO message_attachments
       (message_id, attachment_name, attachment_url, attachment_type, attachment_size)
     VALUES ?`,
    [values]
  );
};

const fetchAttachmentsForMessages = async (messageIds) => {
  const validIds = toValidUniqueIds(messageIds);

  if (validIds.length === 0) {
    return new Map();
  }

  const [rows] = await db.query(`
    SELECT
      attachment_id,
      message_id,
      attachment_name,
      attachment_url,
      attachment_type,
      attachment_size,
      created_at
    FROM message_attachments
    WHERE message_id IN (?)
    ORDER BY message_id ASC, attachment_id ASC
  `, [validIds]);

  const grouped = groupRowsByKey(rows, "message_id");
  const byMessage = new Map();

  for (const [messageId, attachmentRows] of grouped.entries()) {
    const frozenRows = attachmentRows.map((row) => Object.freeze({ ...row }));
    byMessage.set(messageId, Object.freeze(frozenRows));
  }

  return byMessage;
};

const fetchReplySnapshots = async (replyToMessageIds) => {
  const validIds = toValidUniqueIds(replyToMessageIds);

  if (validIds.length === 0) {
    return new Map();
  }

  const [rows] = await db.query(`
    SELECT
      m.message_id,
      m.sender_id,
      m.message,
      COALESCE(u.f_name, 'System') AS f_name,
      COALESCE(u.l_name, '') AS l_name
    FROM messages m
    LEFT JOIN users u
      ON u.user_id = m.sender_id
    WHERE m.message_id IN (?)
  `, [validIds]);

  const attachmentsByMessage = await fetchAttachmentsForMessages(validIds);

  const snapshots = new Map();

  for (const row of rows) {
    snapshots.set(row.message_id, Object.freeze({
      message_id: row.message_id,
      sender_id: row.sender_id,
      sender_name: `${row.f_name} ${row.l_name}`.trim(),
      message: row.message,
      attachments: attachmentsByMessage.get(row.message_id) ?? []
    }));
  }

  return snapshots;
};

const isValidReactionCode = (value) =>
  typeof value === "string" && ALLOWED_REACTION_CODES.has(value);

const fetchMessageWithinAcademicYear = async (runner, messageId, academicYearId) => {
  const [rows] = await runner.execute(`
    SELECT message_id, conversation_id
    FROM messages
    WHERE message_id = ?
    AND academic_year_id = ?
    LIMIT 1
  `, [messageId, academicYearId]);

  return rows[0] || null;
};

const isConversationMember = async (runner, conversationId, userId, academicYearId) => {
  const [rows] = await runner.execute(`
    SELECT 1
    FROM conversation_members cm
    JOIN conversations c
      ON c.conversation_id = cm.conversation_id
    WHERE cm.conversation_id = ?
    AND cm.user_id = ?
    AND c.academic_year_id = ?
    LIMIT 1
  `, [conversationId, userId, academicYearId]);

  return rows.length > 0;
};

const assertMessageAccess = async (runner, messageId, userId, academicYearId) => {
  const message = await fetchMessageWithinAcademicYear(runner, messageId, academicYearId);

  if (!message) {
    throw new NotFoundError("Message not found for the supplied academic year");
  }

  const member = await isConversationMember(runner, message.conversation_id, userId, academicYearId);

  if (!member) {
    throw new ForbiddenError("User is not a member of this conversation");
  }

  return message;
};

const assertConversationAccess = async (runner, conversationId, userId, academicYearId) => {
  const member = await isConversationMember(runner, conversationId, userId, academicYearId);

  if (!member) {
    throw new ForbiddenError("User is not a member of this conversation");
  }
};

const resolveReplyToMessageId = async (conn, replyToMessageId, conversationId) => {
  if (replyToMessageId === null || replyToMessageId === undefined) {
    return null;
  }

  if (!isPositiveInt(replyToMessageId)) {
    throw new ValidationError("replyToMessageId must be null or a positive integer");
  }

  const [rows] = await conn.execute(`
    SELECT message_id
    FROM messages
    WHERE message_id = ?
    AND conversation_id = ?
    LIMIT 1
  `, [replyToMessageId, conversationId]);

  if (rows.length === 0) {
    throw new NotFoundError("The message being replied to was not found in this conversation");
  }

  return replyToMessageId;
};

const groupReactionRows = (rows) => {
  const grouped = groupRowsByKey(rows, "reaction_code");

  return [...grouped.entries()].map(([reaction_code, codeRows]) => ({
    reaction_code,
    count: codeRows.length,
    users: codeRows.map((row) => ({
      user_id: row.user_id,
      f_name: row.f_name,
      l_name: row.l_name,
      photo: row.photo,
      role: row.role
    }))
  }));
};

const buildMessageReactionSummary = async (runner, messageId) => {
  const [rows] = await runner.execute(`
    SELECT mr.reaction_code, u.user_id, u.f_name, u.l_name, u.photo, u.role
    FROM message_reactions mr
    JOIN users u ON u.user_id = mr.user_id
    WHERE mr.message_id = ?
    ORDER BY mr.reaction_code ASC, mr.created_at ASC
  `, [messageId]);

  return {
    message_id: messageId,
    total: rows.length,
    reactions: groupReactionRows(rows)
  };
};

const fetchReactionsForMessages = async (messageIds) => {
  const validIds = toValidUniqueIds(messageIds);

  if (validIds.length === 0) {
    return new Map();
  }

  const [rows] = await db.query(`
    SELECT mr.message_id, mr.reaction_code, u.user_id, u.f_name, u.l_name, u.photo, u.role
    FROM message_reactions mr
    JOIN users u ON u.user_id = mr.user_id
    WHERE mr.message_id IN (?)
    ORDER BY mr.message_id ASC, mr.reaction_code ASC, mr.created_at ASC
  `, [validIds]);

  const byMessage = groupRowsByKey(rows, "message_id");
  const summaries = new Map();

  for (const [messageId, messageRows] of byMessage.entries()) {
    summaries.set(messageId, {
      total: messageRows.length,
      reactions: groupReactionRows(messageRows)
    });
  }

  return summaries;
};

const MESSAGE_SELECT_BASE = `
  SELECT
    m.*,
    COALESCE(u.f_name, 'System') AS f_name,
    COALESCE(u.l_name, '') AS l_name,
    u.photo,
    u.role,
    (mr_me.user_id IS NOT NULL) AS read_by_me,
    (
      SELECT COUNT(*)
      FROM message_reads mr
      WHERE mr.message_id = m.message_id
    ) AS read_count
  FROM messages m
  LEFT JOIN users u
    ON m.sender_id = u.user_id
  LEFT JOIN message_reads mr_me
    ON mr_me.message_id = m.message_id AND mr_me.user_id = ?
`;

const enrichMessageRows = async (rows) => {
  if (rows.length === 0) {
    return rows;
  }

  const messageIds = rows.map((row) => row.message_id);
  const replyToIds = rows
    .map((row) => row.reply_to_message_id)
    .filter(isPositiveInt);

  const [mentionsByMessage, reactionsByMessage, attachmentsByMessage, replySnapshots] = await Promise.all([
    fetchMentionsForMessages(messageIds),
    fetchReactionsForMessages(messageIds),
    fetchAttachmentsForMessages(messageIds),
    fetchReplySnapshots(replyToIds)
  ]);

  return rows.map((row) => ({
    ...row,
    mentions: mentionsByMessage.get(row.message_id) || [],
    reactions: reactionsByMessage.get(row.message_id) || { total: 0, reactions: [] },
    attachments: attachmentsByMessage.get(row.message_id) ?? [],
    reply_to: isPositiveInt(row.reply_to_message_id)
      ? (replySnapshots.get(row.reply_to_message_id) ?? null)
      : null
  }));
};

// Consultation Contacts
const buildConsultationContactsQuery = (targetUsersSql) => `
  SELECT
    t.user_id,
    t.f_name,
    t.l_name,
    t.photo,
    t.role,
    pc.conversation_id AS conversation_id,
    lm.message AS last_message,
    lm.created_at AS last_message_time,
    COALESCE(uc.unread_count, 0) AS unread_count
  FROM (${targetUsersSql}) t
  LEFT JOIN (
    SELECT
      cm1.user_id AS anchor_id,
      cm2.user_id AS other_id,
      MIN(c.conversation_id) AS conversation_id
    FROM conversation_members cm1
    JOIN conversation_members cm2
      ON cm2.conversation_id = cm1.conversation_id
     AND cm2.user_id != cm1.user_id
    JOIN conversations c
      ON c.conversation_id = cm1.conversation_id
    WHERE c.conversation_type = 'private'
    AND c.academic_year_id = ?
    AND cm1.user_id = ?
    GROUP BY cm1.user_id, cm2.user_id
  ) pc ON pc.other_id = t.user_id
  LEFT JOIN messages lm
    ON lm.message_id = (
      SELECT m.message_id
      FROM messages m
      WHERE m.conversation_id = pc.conversation_id
      AND m.academic_year_id = ?
      ORDER BY m.created_at DESC, m.message_id DESC
      LIMIT 1
    )
  LEFT JOIN (
    SELECT m2.conversation_id, COUNT(*) AS unread_count
    FROM messages m2
    WHERE m2.academic_year_id = ?
    AND (m2.sender_id != ? OR m2.sender_id IS NULL)
    AND NOT EXISTS (
      SELECT 1
      FROM message_reads mr
      WHERE mr.message_id = m2.message_id
      AND mr.user_id = ?
    )
    GROUP BY m2.conversation_id
  ) uc ON uc.conversation_id = pc.conversation_id
  ORDER BY COALESCE(lm.created_at, '1970-01-01') DESC, t.f_name ASC, t.user_id ASC
`;

const buildConsultationTargetQuery = (role) => {
  if (role === "student") {
    return `
      SELECT DISTINCT u.user_id, u.f_name, u.l_name, u.photo, u.role
      FROM students s
      JOIN coordinators co
        ON co.department_id = s.department_id
      JOIN users u
        ON u.user_id = co.user_id
      WHERE s.user_id = ?
      AND u.role = 'coordinator'
    `;
  }

  if (role === "coordinator") {
    return `
      SELECT DISTINCT u.user_id, u.f_name, u.l_name, u.photo, u.role
      FROM coordinators c
      JOIN students s
        ON s.department_id = c.department_id
      JOIN users u
        ON u.user_id = s.user_id
      WHERE c.user_id = ?
      AND u.role = 'student'
    `;
  }

  return `
    SELECT DISTINCT u.user_id, u.f_name, u.l_name, u.photo, u.role
    FROM users u
    WHERE u.role IN ('student', 'coordinator')
    AND u.user_id != ?
  `;
};

const fetchDepartmentConversationRow = async (conn, departmentId, academicYearId) => {
  const [rows] = await conn.execute(`
    SELECT *
    FROM conversations
    WHERE department_id = ?
    AND academic_year_id = ?
    AND conversation_type = 'group'
    LIMIT 1
  `, [departmentId, academicYearId]);

  return rows[0] || null;
};

// Returns the department row, or throws NotFoundError.
const fetchDepartmentOrThrow = async (conn, departmentId) => {
  const [rows] = await conn.execute(`
    SELECT *
    FROM departments
    WHERE department_id = ?
    LIMIT 1
  `, [departmentId]);

  const department = rows[0] || null;

  if (!department) {
    throw new NotFoundError("Department not found");
  }

  return department;
};

// Returns user_ids of active students in a department for an academic year.
const fetchDepartmentStudentIds = async (conn, departmentId, academicYearId) => {
  const [rows] = await conn.execute(`
    SELECT user_id
    FROM students
    WHERE department_id = ?
    AND academic_year_id = ?
    AND is_active = 1
  `, [departmentId, academicYearId]);

  return rows.map((row) => row.user_id);
};

const fetchDepartmentCoordinatorIds = async (conn, departmentId) => {
  const [rows] = await conn.execute(`
    SELECT user_id
    FROM coordinators
    WHERE department_id = ?
    AND is_active = 1
  `, [departmentId]);

  return rows.map((row) => row.user_id);
};

// Returns the current member user_ids of a conversation as a Set.
const fetchConversationMemberIdSet = async (conn, conversationId) => {
  const [rows] = await conn.execute(`
    SELECT user_id
    FROM conversation_members
    WHERE conversation_id = ?
  `, [conversationId]);

  return new Set(rows.map((row) => row.user_id));
};

const insertConversationMember = async (conn, conversationId, userId) => {
  const params = [conversationId, userId];
  console.log("Insert parameters:", params);

  let result;

  try {
    [result] = await conn.execute(
      `INSERT INTO conversation_members (conversation_id, user_id, joined_at)
       VALUES (?, ?, NOW())`,
      params
    );
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") {

      console.log("SYNC INSERT SKIPPED (duplicate membership)", { conversationId, userId });
      return { inserted: false, reason: "duplicate" };
    }

    console.log("SYNC INSERT FAILED", {
      conversationId,
      userId,
      code: err && err.code,
      errno: err && err.errno,
      sqlMessage: err && err.sqlMessage,
      message: err && err.message
    });
    throw err;
  }

  console.log("Insert result:", {
    affectedRows: result.affectedRows,
    warningStatus: result.warningStatus,
    insertId: result.insertId
  });

  const [verificationRows] = await conn.execute(`
    SELECT *
    FROM conversation_members
    WHERE conversation_id = ?
    AND user_id = ?
  `, [conversationId, userId]);

  console.log("Verification query:", verificationRows);

  if (verificationRows.length === 0) {

    console.log("SYNC INSERT VERIFICATION FAILED - row not found after insert", {
      conversationId,
      userId
    });
    throw new ConflictError(
      `Failed to verify conversation_members insert for conversation ${conversationId}, user ${userId}`
    );
  }

  return { inserted: true, reason: null };
};

const NOTIFICATION_PREVIEW_LENGTH = 80;
const ATTACHMENT_ONLY_PREVIEW = "Sent an attachment.";

const buildNotificationPreview = (normalizedMessage, hasAttachment) => {
  if (!normalizedMessage) {
    return hasAttachment ? ATTACHMENT_ONLY_PREVIEW : "";
  }

  if (normalizedMessage.length <= NOTIFICATION_PREVIEW_LENGTH) {
    return normalizedMessage;
  }

  return `${normalizedMessage.slice(0, NOTIFICATION_PREVIEW_LENGTH - 1).trim()}…`;
};

const resolveMentionRecipientIds = (mention, members, senderId) => {
  if (mention.type === "user") {
    return isPositiveInt(mention.userId) && mention.userId !== senderId
      ? [mention.userId]
      : [];
  }

  if (mention.type === "student" || mention.type === "coordinator") {
    return members
      .filter((member) => member.role === mention.type && member.user_id !== senderId)
      .map((member) => member.user_id);
  }

  return [];
};

// A plain consultation message (no @mention) must NOT create a row in the
// normal `notifications` table / `notification:new` event — that flow
// belongs entirely to the message system (receive_message -> Sidebar's
// consultation badge / ConversationList unread_count, both already live).
// This function previously ALSO sent a "New message from X" notification
// to every recipient here, which is exactly what put ordinary chat
// messages into the TopBar bell; that block has been removed.
//
// Being @mentioned is kept as the one genuine, intentional exception: the
// app already has dedicated mention-parsing (extractMentionsFromMessage,
// message_mentions table) distinct from "a message arrived," so it still
// creates a real "You were mentioned" notification via the normal
// notification system, same as before.
const sendMessageNotifications = async ({
  senderId,
  conversationId,
  messageId,
  normalizedMessage,
  hasAttachment,
  members,
  mentions,
  academicYearId
}) => {
  try {
    if (!Array.isArray(mentions) || mentions.length === 0) {
      return;
    }

    const preview = buildNotificationPreview(normalizedMessage, hasAttachment);
    const link = `/messenger/conversations/${conversationId}`;

    const mentionRecipientIds = new Set();

    for (const mention of mentions) {
      for (const userId of resolveMentionRecipientIds(mention, members, senderId)) {
        mentionRecipientIds.add(userId);
      }
    }

    await Promise.all([...mentionRecipientIds].map((userId) => sendNotification({
      user_id: userId,
      sender_id: senderId,
      reference_id: messageId,
      title: "You were mentioned",
      message: preview,
      type: NotificationTypes.CONSULTATION,
      link,
      academic_year_id: academicYearId
    })));

  } catch (err) {
    console.log("SEND MESSAGE NOTIFICATION FAILED", {
      conversationId,
      messageId,
      code: err && err.code,
      message: err && err.message
    });
  }
};

const MessageModel = {

  // Private Conversation
  async getOrCreatePrivateConversation(user1, user2, academicYearId) {

    if (!isPositiveInt(user1) || !isPositiveInt(user2) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("user1, user2, and academicYearId must be positive integers");
    }

    if (user1 === user2) {
      throw new ValidationError("Cannot create a private conversation with yourself");
    }

    const [a, b] = [user1, user2].sort((x, y) => x - y);
    const lockName = `private_conv_${a}_${b}_${academicYearId}`;

    const conn = await db.getConnection();
    let lockAcquired = false;

    try {
      const [[lockRow]] = await conn.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
      lockAcquired = lockRow?.acquired === 1;

      if (!lockAcquired) {
        throw new ConflictError("Could not acquire conversation lock, please retry");
      }

      await conn.beginTransaction();

      const [existing] = await conn.execute(`
        SELECT c.conversation_id
        FROM conversations c
        JOIN conversation_members cm1
          ON cm1.conversation_id = c.conversation_id AND cm1.user_id = ?
        JOIN conversation_members cm2
          ON cm2.conversation_id = c.conversation_id AND cm2.user_id = ?
        WHERE c.conversation_type = 'private'
        AND c.academic_year_id = ?
        AND (
          SELECT COUNT(*)
          FROM conversation_members cm
          WHERE cm.conversation_id = c.conversation_id
        ) = 2
        ORDER BY c.created_at ASC, c.conversation_id ASC
        LIMIT 1
      `, [user1, user2, academicYearId]);

      if (existing.length > 0) {
        await conn.commit();
        return existing[0].conversation_id;
      }

      const [convResult] = await conn.execute(
        `INSERT INTO conversations
           (conversation_name, conversation_type, department_id, academic_year_id, created_by, created_at)
         VALUES (NULL, 'private', NULL, ?, ?, NOW())`,
        [academicYearId, user1]
      );

      const conversationId = convResult.insertId;

      await conn.execute(
        `INSERT INTO conversation_members (conversation_id, user_id, joined_at)
         VALUES (?, ?, NOW()), (?, ?, NOW())`,
        [conversationId, user1, conversationId, user2]
      );

      await conn.commit();
      return conversationId;

    } catch (err) {
      await conn.rollback();
      throw err;

    } finally {
      if (lockAcquired) {
        await conn.query("SELECT RELEASE_LOCK(?)", [lockName]);
      }
      conn.release();
    }
  },


  // Send Message
  async sendMessage(senderId, conversationId, message, options = {}) {

    if (!isPositiveInt(conversationId)) {
      throw new ValidationError("conversationId is required and must be a positive integer");
    }

    if (!isNullableOrPositiveInt(senderId)) {
      throw new ValidationError("senderId must be null or a positive integer");
    }

    const {
      messageType = "text",
      relatedLogId = null,
      relatedNarrativeId = null,
      academicYearId = null,
      attachments = [],
      replyToMessageId = null
    } = options;

    if (!isPositiveInt(academicYearId)) {
      throw new ValidationError("academicYearId is required and must be a positive integer");
    }

    if (!ALLOWED_MESSAGE_TYPES.has(messageType)) {
      throw new ValidationError(`messageType must be one of: ${[...ALLOWED_MESSAGE_TYPES].join(", ")}`);
    }

    if (!isNullableOrPositiveInt(relatedLogId)) {
      throw new ValidationError("relatedLogId must be null or a positive integer");
    }

    if (!isNullableOrPositiveInt(relatedNarrativeId)) {
      throw new ValidationError("relatedNarrativeId must be null or a positive integer");
    }

    if (!isNullableOrPositiveInt(replyToMessageId)) {
      throw new ValidationError("replyToMessageId must be null or a positive integer");
    }

    const normalizedMessage = typeof message === "string" ? message.trim() : "";
    const hasText = normalizedMessage !== "";
    const hasAttachment = Array.isArray(attachments) && attachments.length > 0;

    if (!hasText && !hasAttachment) {
      throw new ValidationError("Message must include text or an attachment");
    }

    const conn = await db.getConnection();

    let members = [];
    let mentions = [];

    try {
      await conn.beginTransaction();

      if (senderId) {
        await assertConversationAccess(conn, conversationId, senderId, academicYearId);
      }

      // Replies must target a message that exists in this same conversation.
      const resolvedReplyToMessageId = await resolveReplyToMessageId(conn, replyToMessageId, conversationId);

      const [result] = await conn.execute(
        `INSERT INTO messages
       (
         sender_id,
         conversation_id,
         message,
         message_type,
         related_log_id,
         related_narrative_id,
         academic_year_id,
         reply_to_message_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          senderId,
          conversationId,
          normalizedMessage,
          messageType,
          relatedLogId,
          relatedNarrativeId,
          academicYearId,
          resolvedReplyToMessageId
        ]
      );

      const messageId = result.insertId;

      await saveMessageAttachments(conn, messageId, attachments);

      if (senderId) {
        await conn.execute(
          `INSERT IGNORE INTO message_reads (message_id, user_id, read_at)
           VALUES (?, ?, NOW())`,
          [messageId, senderId]
        );
      }

      members = await fetchConversationMembers(conn, conversationId, academicYearId);

      if (hasText) {
        mentions = extractMentionsFromMessage(normalizedMessage, members);
        await insertMentionRecords(conn, messageId, mentions);
      }

      await conn.commit();
    
      const [freshRows] = await db.execute(`
        ${MESSAGE_SELECT_BASE}
        WHERE m.message_id = ?
        LIMIT 1
      `, [senderId, messageId]);

      const [enrichedMessage] = await enrichMessageRows(freshRows);

      await sendMessageNotifications({
        senderId,
        conversationId,
        messageId,
        normalizedMessage,
        hasAttachment,
        members,
        mentions,
        academicYearId
      });

      return { ...result, message: enrichedMessage };

    } catch (err) {
      await conn.rollback();
      throw err;

    } finally {
      conn.release();
    }
  },


  // Mentions
  async getMentionsByMessage(messageId, userId, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    await assertMessageAccess(db, messageId, userId, academicYearId);

    const [rows] = await db.execute(`
      SELECT
        mm.mention_id,
        mm.mention_type,
        mm.mentioned_user_id,
        u.f_name,
        u.l_name,
        u.photo,
        u.role
      FROM message_mentions mm
      LEFT JOIN users u
        ON u.user_id = mm.mentioned_user_id
      WHERE mm.message_id = ?
      ORDER BY mm.mention_id ASC
    `, [messageId]);

    return rows;
  },

  async getMentionsForMessages(messageIds) {
    const grouped = await fetchMentionsForMessages(messageIds);
    return [...grouped.values()].flat();
  },

  async isMember(conversationId, userId, academicYearId) {

    if (!isPositiveInt(conversationId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("conversationId, userId, and academicYearId must be positive integers");
    }

    return isConversationMember(db, conversationId, userId, academicYearId);
  },

  async getConversationMembers(conversationId, academicYearId) {

    if (!isPositiveInt(conversationId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("conversationId and academicYearId must be positive integers");
    }

    return fetchConversationMembers(db, conversationId, academicYearId);
  },

  async getConversationIdByMessage(messageId, academicYearId = null) {

    if (!isPositiveInt(messageId)) {
      throw new ValidationError("messageId must be a positive integer");
    }

    if (!isNullableOrPositiveInt(academicYearId)) {
      throw new ValidationError("academicYearId must be null or a positive integer");
    }

    const conditions = ["message_id = ?"];
    const params = [messageId];

    if (academicYearId !== null) {
      conditions.push("academic_year_id = ?");
      params.push(academicYearId);
    }

    const [rows] = await db.execute(
      `SELECT conversation_id FROM messages WHERE ${conditions.join(" AND ")} LIMIT 1`,
      params
    );

    return rows[0]?.conversation_id ?? null;
  },


  // Message List
  async getMessagesByConversation(conversationId, userId, academicYearId) {

    if (!isPositiveInt(conversationId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("conversationId, userId, and academicYearId must be positive integers");
    }

    await assertConversationAccess(db, conversationId, userId, academicYearId);

    const [rows] = await db.execute(`
      ${MESSAGE_SELECT_BASE}
      WHERE m.conversation_id = ?
      AND m.academic_year_id = ?
      ORDER BY m.created_at ASC
    `, [userId, conversationId, academicYearId]);

    return enrichMessageRows(rows);
  },

  async getEnrichedMessage(messageId, userId, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    await assertMessageAccess(db, messageId, userId, academicYearId);

    const [rows] = await db.execute(`
      ${MESSAGE_SELECT_BASE}
      WHERE m.message_id = ?
      AND m.academic_year_id = ?
      LIMIT 1
    `, [userId, messageId, academicYearId]);

    if (!rows[0]) {
      return null;
    }

    const [enriched] = await enrichMessageRows(rows);
    return enriched;
  },


  // Read Receipts
  async markConversationRead(conversationId, userId, academicYearId) {

    if (!isPositiveInt(conversationId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("conversationId, userId, and academicYearId must be positive integers");
    }

    await assertConversationAccess(db, conversationId, userId, academicYearId);

    await db.execute(`
      INSERT IGNORE INTO message_reads (message_id, user_id, read_at)
      SELECT m.message_id, ?, NOW()
      FROM messages m
      WHERE m.conversation_id = ?
      AND m.academic_year_id = ?
      AND (m.sender_id != ? OR m.sender_id IS NULL)
    `, [userId, conversationId, academicYearId, userId]);
  },

  async getReadReceipts(messageId, userId, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    await assertMessageAccess(db, messageId, userId, academicYearId);

    const [rows] = await db.execute(`
      SELECT
        u.user_id,
        u.f_name,
        u.l_name,
        u.photo,
        u.role,
        mr.read_at
      FROM message_reads mr
      JOIN users u ON u.user_id = mr.user_id
      WHERE mr.message_id = ?
      ORDER BY mr.read_at ASC
    `, [messageId]);

    return rows;
  },


  // Reactions
  async toggleReaction(messageId, userId, reactionCode, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    if (!isValidReactionCode(reactionCode)) {
      throw new ValidationError(`reactionCode must be one of: ${[...ALLOWED_REACTION_CODES].join(", ")}`);
    }

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      await assertMessageAccess(conn, messageId, userId, academicYearId);

      const [existingRows] = await conn.execute(`
        SELECT reaction_id, reaction_code
        FROM message_reactions
        WHERE message_id = ?
        AND user_id = ?
        FOR UPDATE
      `, [messageId, userId]);

      const existing = existingRows[0] || null;
      let action;
      let resultCode = reactionCode;

      if (!existing) {
        await conn.execute(`
          INSERT INTO message_reactions (message_id, user_id, reaction_code, created_at)
          VALUES (?, ?, ?, NOW())
        `, [messageId, userId, reactionCode]);
        action = "added";

      } else if (existing.reaction_code === reactionCode) {
        await conn.execute(
          `DELETE FROM message_reactions WHERE reaction_id = ?`,
          [existing.reaction_id]
        );
        action = "removed";
        resultCode = null;

      } else {
        await conn.execute(`
          UPDATE message_reactions
          SET reaction_code = ?, created_at = NOW()
          WHERE reaction_id = ?
        `, [reactionCode, existing.reaction_id]);
        action = "updated";
      }

      const summary = await buildMessageReactionSummary(conn, messageId);

      await conn.commit();

      return { action, reaction_code: resultCode, summary };

    } catch (err) {
      await conn.rollback();
      throw err;

    } finally {
      conn.release();
    }
  },

  async removeReaction(messageId, userId, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      await assertMessageAccess(conn, messageId, userId, academicYearId);

      await conn.execute(
        `DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?`,
        [messageId, userId]
      );

      const summary = await buildMessageReactionSummary(conn, messageId);

      await conn.commit();

      return summary;

    } catch (err) {
      await conn.rollback();
      throw err;

    } finally {
      conn.release();
    }
  },

  async getMessageReactions(messageId, userId, academicYearId) {

    if (!isPositiveInt(messageId) || !isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("messageId, userId, and academicYearId must be positive integers");
    }

    await assertMessageAccess(db, messageId, userId, academicYearId);

    return buildMessageReactionSummary(db, messageId);
  },

  async getConversationReactions(conversationId, academicYearId, userId = null) {

    if (!isPositiveInt(conversationId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("conversationId and academicYearId must be positive integers");
    }

    if (!isNullableOrPositiveInt(userId)) {
      throw new ValidationError("userId must be null or a positive integer");
    }

    if (userId !== null) {
      await assertConversationAccess(db, conversationId, userId, academicYearId);
    }

    const [rows] = await db.execute(`
      SELECT mr.message_id, mr.reaction_code, u.user_id, u.f_name, u.l_name, u.photo, u.role
      FROM message_reactions mr
      JOIN messages m
        ON m.message_id = mr.message_id
      JOIN users u
        ON u.user_id = mr.user_id
      WHERE m.conversation_id = ?
      AND m.academic_year_id = ?
      ORDER BY mr.message_id ASC, mr.reaction_code ASC, mr.created_at ASC
    `, [conversationId, academicYearId]);

    const byMessage = groupRowsByKey(rows, "message_id");

    return [...byMessage.entries()].map(([messageId, messageRows]) => ({
      message_id: messageId,
      total: messageRows.length,
      reactions: groupReactionRows(messageRows)
    }));
  },

  // Returns the department group conversation, or null if none exists.
  async getDepartmentConversation(conn, departmentId, academicYearId) {

    if (!isPositiveInt(departmentId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("departmentId and academicYearId must be positive integers");
    }

    return fetchDepartmentConversationRow(conn, departmentId, academicYearId);
  },

  // Creates the department group conversation and returns the new row.
  async createDepartmentConversation(conn, departmentId, academicYearId, createdBy = null) {

    if (!isPositiveInt(departmentId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("departmentId and academicYearId must be positive integers");
    }

    if (!isNullableOrPositiveInt(createdBy)) {
      throw new ValidationError("createdBy must be null or a positive integer");
    }

    const department = await fetchDepartmentOrThrow(conn, departmentId);
    const conversationName = `${department.department_name} OJT Consultation`;

    try {
      const [result] = await conn.execute(
        `INSERT INTO conversations
           (conversation_name, conversation_type, department_id, academic_year_id, created_by, created_at)
         VALUES (?, 'group', ?, ?, ?, NOW())`,
        [conversationName, departmentId, academicYearId, createdBy]
      );


      return fetchDepartmentConversationRow(conn, departmentId, academicYearId);

    } catch (err) {

      if (err && err.code === "ER_DUP_ENTRY") {
        const existing = await fetchDepartmentConversationRow(conn, departmentId, academicYearId);

        if (existing) {
          return existing;
        }
      }

      throw err;
    }
  },

  // Returns user_ids of active students in a department/academic year.
  async getDepartmentStudents(conn, departmentId, academicYearId) {

    if (!isPositiveInt(departmentId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("departmentId and academicYearId must be positive integers");
    }

    return fetchDepartmentStudentIds(conn, departmentId, academicYearId);
  },

  // Returns user_ids of active coordinators in a department.
  async getDepartmentCoordinators(conn, departmentId) {

    if (!isPositiveInt(departmentId)) {
      throw new ValidationError("departmentId must be a positive integer");
    }

    return fetchDepartmentCoordinatorIds(conn, departmentId);
  },

  // Returns the current member user_ids of a conversation as a Set.
  async getConversationMemberIds(conn, conversationId) {

    if (!isPositiveInt(conversationId)) {
      throw new ValidationError("conversationId must be a positive integer");
    }

    return fetchConversationMemberIdSet(conn, conversationId);
  },

  async syncDepartmentConversation(conn, departmentId, academicYearId, createdBy = null) {

    if (!isPositiveInt(departmentId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("departmentId and academicYearId must be positive integers");
    }

    if (!isNullableOrPositiveInt(createdBy)) {
      throw new ValidationError("createdBy must be null or a positive integer");
    }

    // Find or create the department group.
    let conversation = await MessageModel.getDepartmentConversation(conn, departmentId, academicYearId);

    if (!conversation) {
      conversation = await MessageModel.createDepartmentConversation(conn, departmentId, academicYearId, createdBy);
    }

    const conversationId = conversation.conversation_id;

    // Expected roster: active students + active coordinators.
    const [studentIds, coordinatorIds] = await Promise.all([
      MessageModel.getDepartmentStudents(conn, departmentId, academicYearId),
      MessageModel.getDepartmentCoordinators(conn, departmentId)
    ]);

    const expectedMemberIds = new Set([...studentIds, ...coordinatorIds]);
    const currentMemberIds = await MessageModel.getConversationMemberIds(conn, conversationId);

    const membersToAdd = [...expectedMemberIds].filter((userId) => !currentMemberIds.has(userId));
    const membersToRemove = [...currentMemberIds].filter((userId) => !expectedMemberIds.has(userId));

    console.log("Members to add:", membersToAdd);


    let addedCount = 0;

    for (const userId of membersToAdd) {
      const insertOutcome = await insertConversationMember(conn, conversationId, userId);

      if (insertOutcome.inserted) {
        addedCount += 1;
      }
    }

    if (membersToRemove.length > 0) {
      await conn.query(
        `DELETE FROM conversation_members
         WHERE conversation_id = ?
         AND user_id IN (?)`,
        [conversationId, membersToRemove]
      );
    }

    console.log("SYNC EXECUTED", {
      conversationId,
      studentIds,
      coordinatorIds,
      expected: [...expectedMemberIds],
      current: [...currentMemberIds],
      membersToAdd,
      membersToRemove,
      addedCount
    });

    return {
      conversationId,
      conversation,
      addedCount,
      removedCount: membersToRemove.length,
      memberCount: expectedMemberIds.size
    };
  },


  // Conversation List
  async getConversations(userId, academicYearId) {

    if (!isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("userId and academicYearId must be positive integers");
    }

    const params = [
      academicYearId,
      userId,
      userId,
      userId,
      userId,
      academicYearId,
      academicYearId
    ];

    const [rows] = await db.execute(`
      SELECT
        c.conversation_id,
        CASE
          WHEN c.conversation_type = 'group' THEN 1
          ELSE 0
        END AS is_group,
        c.conversation_name AS name,
        c.created_at AS conversation_created_at,

        ou.user_id AS user_id,
        ou.f_name AS f_name,
        ou.l_name AS l_name,
        ou.photo AS photo,
        ou.role AS role,

        (
          SELECT COUNT(*)
          FROM conversation_members cm2
          WHERE cm2.conversation_id = c.conversation_id
        ) AS member_count,

        lm.message AS last_message,
        lm.created_at AS last_message_time,

        (
          SELECT COUNT(*)
          FROM messages m2
          WHERE m2.conversation_id = c.conversation_id
          AND m2.academic_year_id = ?
          AND (m2.sender_id != ? OR m2.sender_id IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM message_reads mr
            WHERE mr.message_id = m2.message_id
            AND mr.user_id = ?
          )
        ) AS unread_count

      FROM conversations c

      JOIN conversation_members cm
        ON cm.conversation_id = c.conversation_id AND cm.user_id = ?

      LEFT JOIN users ou
        ON ou.user_id = (
          SELECT ocm.user_id
          FROM conversation_members ocm
          WHERE ocm.conversation_id = c.conversation_id
          AND ocm.user_id != ?
          AND c.conversation_type = 'private'
          LIMIT 1
        )

      LEFT JOIN messages lm
        ON lm.message_id = (
          SELECT m.message_id
          FROM messages m
          WHERE m.conversation_id = c.conversation_id
          AND m.academic_year_id = ?
          ORDER BY m.created_at DESC
          LIMIT 1
        )

      WHERE c.academic_year_id = ?
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC
    `, params);

    return rows.map(row => {
      if (row.is_group) {
        return {
          conversation_id: row.conversation_id,
          is_group: row.is_group,
          name: row.name || "Department Group",
          member_count: row.member_count,
          last_message: row.last_message,
          last_message_time: row.last_message_time,
          unread_count: row.unread_count
        };
      }

      return {
        conversation_id: row.conversation_id,
        is_group: row.is_group,
        user_id: row.user_id,
        f_name: row.f_name,
        l_name: row.l_name,
        photo: row.photo,
        role: row.role,
        last_message: row.last_message,
        last_message_time: row.last_message_time,
        unread_count: row.unread_count
      };
    });
  },


  // Consultation Contacts
  async getConsultationContacts(userId, role, academicYearId) {

    if (!isPositiveInt(userId) || !isPositiveInt(academicYearId)) {
      throw new ValidationError("userId and academicYearId must be positive integers");
    }

    if (typeof role !== "string" || !ALLOWED_CONSULTATION_ROLES.has(role)) {
      throw new ValidationError(`role must be one of: ${[...ALLOWED_CONSULTATION_ROLES].join(", ")}`);
    }

    const targetUsersSql = buildConsultationTargetQuery(role);
    const query = buildConsultationContactsQuery(targetUsersSql);

    const targetParams = [userId];

    const pcParams = [academicYearId, userId];
    const lmParams = [academicYearId];
    const ucParams = [academicYearId, userId, userId];

    const params = [...targetParams, ...pcParams, ...lmParams, ...ucParams];

    const [rows] = await db.execute(query, params);

    return rows.map((row) => ({
      conversation_id: row.conversation_id ?? null,
      is_group: 0,
      user_id: row.user_id,
      f_name: row.f_name,
      l_name: row.l_name,
      photo: row.photo,
      role: row.role,
      last_message: row.last_message,
      last_message_time: row.last_message_time,
      unread_count: row.unread_count
    }));
  }

};

module.exports = MessageModel;