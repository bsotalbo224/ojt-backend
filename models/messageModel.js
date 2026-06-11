const db = require("../config/db");

const MessageModel = {

  /*
  =================================
  SEND MESSAGE
  =================================
  */
  async sendMessage(senderId, receiverId, message, options = {}) {

    const {
      messageType = "normal",
      relatedLogId = null,
      relatedNarrativeId = null,
      academicYearId = null
    } = options;

    const [result] = await db.execute(
      `INSERT INTO messages
     (
       sender_id,
       receiver_id,
       message,
       message_type,
       related_log_id,
       related_narrative_id,
       academic_year_id
     )
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        senderId ?? null,
        receiverId,
        message,
        messageType,
        relatedLogId ?? null,
        relatedNarrativeId ?? null,
        academicYearId
      ]
    );

    return result;
  },


  /*
  =================================
  GET CONVERSATION BETWEEN USERS
  =================================
  */
  async getConversation(
    user1,
    user2,
    academic_year_id
  ) {

    const [rows] = await db.execute(`
      SELECT
        m.*,
        COALESCE(u.f_name, 'System') AS f_name,
        COALESCE(u.l_name, '') AS l_name,
        u.photo
      FROM messages m
      LEFT JOIN users u
        ON m.sender_id = u.user_id
      WHERE (
           (m.sender_id = ? AND m.receiver_id = ?)
        OR (m.sender_id = ? AND m.receiver_id = ?)
        OR (m.sender_id IS NULL AND m.receiver_id = ?)
      )
      AND m.academic_year_id = ?
      ORDER BY m.created_at ASC
    `, [
      user1,
      user2,
      user2,
      user1,
      user1,
      academic_year_id
    ]);

    return rows;
  },


  /*
  =================================
  MARK MESSAGES AS READ
  =================================
  */
  async markAsRead(senderId, receiverId) {

    await db.execute(
      `UPDATE messages
       SET is_read = 1
       WHERE sender_id = ? AND receiver_id = ?`,
      [senderId, receiverId]
    );

  },


  /*
  =================================
  GET CONVERSATION LIST
  =================================
  */
  async getConversations(
    userId,
    role,
    academic_year_id
  ) {

    if (role === "student") {

      const [rows] = await db.execute(`
      SELECT
        u.user_id,
        u.f_name,
        u.l_name,
        u.photo,
        'coordinator' AS role,

        COALESCE(MAX(m.created_at), NOW()) AS last_message_time,

        COALESCE(MAX(m.message), '') AS last_message

      FROM students s
      JOIN coordinators c
        ON c.department_id = s.department_id
      JOIN users u
        ON u.user_id = c.user_id
      LEFT JOIN messages m
        ON (
          (m.sender_id = u.user_id AND m.receiver_id = ?)
          OR
          (m.sender_id = ? AND m.receiver_id = u.user_id)
        )
        AND m.academic_year_id = ?
      WHERE s.user_id = ?
      AND s.academic_year_id = ?
      GROUP BY u.user_id
      ORDER BY last_message_time DESC, u.f_name ASC
    `, [
        userId,
        userId,
        academic_year_id,
        userId,
        academic_year_id
      ]);

      return rows;
    }

    if (role === "coordinator" || role === "admin") {

      const [rows] = await db.execute(`
      SELECT
        u.user_id,
        u.f_name,
        u.l_name,
        u.photo,
        'student' AS role,

        COALESCE(MAX(m.created_at), NOW()) AS last_message_time,

        COALESCE(MAX(m.message), '') AS last_message

      FROM coordinators c
      JOIN students s
        ON s.department_id = c.department_id
      JOIN users u
        ON u.user_id = s.user_id
      LEFT JOIN messages m
        ON (
          (m.sender_id = u.user_id AND m.receiver_id = ?)
          OR
          (m.sender_id = ? AND m.receiver_id = u.user_id)
        )
        AND m.academic_year_id = ?
      WHERE c.user_id = ?
      AND s.academic_year_id = ?
      GROUP BY u.user_id
      ORDER BY last_message_time DESC, u.f_name ASC
    `, [
        userId,
        userId,
        academic_year_id,
        userId,
        academic_year_id
      ]);

      return rows;
    }

    return [];
  }

};

module.exports = MessageModel;