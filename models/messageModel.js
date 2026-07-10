const db = require("../config/db");

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

const ALLOWED_MESSAGE_TYPES = new Set(["text", "file", "system"]);
const ALLOWED_REACTION_CODES = new Set(["like", "love", "laugh", "wow", "sad", "angry"]);

const MAX_MENTION_WORDS = 5;
const MENTION_WORD = "[A-Za-z]+(?:[-'.][A-Za-z]+)*\\.?";
const MENTION_TOKEN_REGEX = new RegExp(
  `@(${MENTION_WORD}(?:\\s+${MENTION_WORD}){0,${MAX_MENTION_WORDS - 1}})`,
  "g"
);

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
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return new Map();
  }

  const validIds = [...new Set(messageIds.filter(isPositiveInt))];

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
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return new Map();
  }

  const validIds = [...new Set(messageIds.filter(isPositiveInt))];

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

  const [mentionsByMessage, reactionsByMessage] = await Promise.all([
    fetchMentionsForMessages(messageIds),
    fetchReactionsForMessages(messageIds)
  ]);

  return rows.map((row) => ({
    ...row,
    mentions: mentionsByMessage.get(row.message_id) || [],
    reactions: reactionsByMessage.get(row.message_id) || { total: 0, reactions: [] }
  }));
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
        WHERE c.is_group = 0
        AND c.academic_year_id = ?
        AND (
          SELECT COUNT(*)
          FROM conversation_members cm
          WHERE cm.conversation_id = c.conversation_id
        ) = 2
        LIMIT 1
      `, [user1, user2, academicYearId]);

      if (existing.length > 0) {
        await conn.commit();
        return existing[0].conversation_id;
      }

      const [convResult] = await conn.execute(
        `INSERT INTO conversations
           (name, is_group, department_id, academic_year_id, created_by, created_at)
         VALUES (NULL, 0, NULL, ?, ?, NOW())`,
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
      attachmentName = null,
      attachmentUrl = null,
      attachmentType = null,
      attachmentSize = null
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

    const hasText = typeof message === "string" && message.trim() !== "";
    const hasAttachment = !!attachmentUrl;

    if (!hasText && !hasAttachment) {
      throw new ValidationError("Message must include text or an attachment");
    }

    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      const [result] = await conn.execute(
        `INSERT INTO messages
       (
         sender_id,
         conversation_id,
         message,
         attachment_name,
         attachment_url,
         attachment_type,
         attachment_size,
         message_type,
         related_log_id,
         related_narrative_id,
         academic_year_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          senderId,
          conversationId,
          hasText ? message.trim() : null,
          attachmentName,
          attachmentUrl,
          attachmentType,
          attachmentSize,
          messageType,
          relatedLogId,
          relatedNarrativeId,
          academicYearId
        ]
      );

      const messageId = result.insertId;

      if (senderId) {
        await conn.execute(
          `INSERT IGNORE INTO message_reads (message_id, user_id, read_at)
           VALUES (?, ?, NOW())`,
          [messageId, senderId]
        );
      }

      if (hasText) {
        const members = await fetchConversationMembers(conn, conversationId, academicYearId);
        const mentions = extractMentionsFromMessage(message.trim(), members);
        await insertMentionRecords(conn, messageId, mentions);
      }

      await conn.commit();
      return result;

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
        c.is_group,
        c.name,
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
          AND c.is_group = 0
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
  }

};

module.exports = MessageModel;