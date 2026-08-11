const db = require("../config/db");

const NOTIFICATION_COLUMNS = `
  notif_id, user_id, sender_id, reference_id, title, message, type, link, is_read, created_at, academic_year_id
`;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function clampPagination(limit, offset) {
  const safeLimit = Number.isInteger(limit) ? limit : DEFAULT_LIMIT;
  const safeOffset = Number.isInteger(offset) ? offset : 0;

  return {
    limit: Math.min(Math.max(safeLimit, 1), MAX_LIMIT),
    offset: Math.max(safeOffset, 0),
  };
}

class NotificationModel {
  static async getByUser(user_id, academic_year_id, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const paged = clampPagination(limit, offset);

    const [rows] = await db.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
       WHERE user_id = ? AND academic_year_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [user_id, academic_year_id, paged.limit, paged.offset]
    );

    return rows;
  }

  static async getUnreadCount(user_id, academic_year_id) {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE user_id = ? AND academic_year_id = ? AND is_read = 0`,
      [user_id, academic_year_id]
    );

    return rows[0].count;
  }

  static async markAsRead(notif_id, user_id) {
    const [result] = await db.query(
      `UPDATE notifications
       SET is_read = 1
       WHERE notif_id = ? AND user_id = ?`,
      [notif_id, user_id]
    );

    return result.affectedRows > 0;
  }

  static async markAllAsRead(user_id, academic_year_id) {
    const [result] = await db.query(
      `UPDATE notifications
       SET is_read = 1
       WHERE user_id = ? AND academic_year_id = ? AND is_read = 0`,
      [user_id, academic_year_id]
    );

    return result.affectedRows;
  }

  static async deleteNotification(notif_id, user_id) {
    const [result] = await db.query(
      `DELETE FROM notifications
       WHERE notif_id = ? AND user_id = ?`,
      [notif_id, user_id]
    );

    return result.affectedRows > 0;
  }

  static async getById(notif_id) {
    const [rows] = await db.query(
      `SELECT ${NOTIFICATION_COLUMNS}
       FROM notifications
       WHERE notif_id = ?`,
      [notif_id]
    );

    return rows[0] ?? null;
  }
}

module.exports = NotificationModel;