const NotificationModel = require("../models/NotificationModel");

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function parseId(rawId) {
  const id = parseInt(rawId, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parsePagination(query) {
  const limit = parseInt(query.limit, 10);
  const offset = parseInt(query.offset, 10);

  return {
    limit: Number.isInteger(limit) ? limit : undefined,
    offset: Number.isInteger(offset) ? offset : undefined,
  };
}

async function getNotifications(req, res) {
  try {
    const { user_id, academic_year_id } = req.user;
    const { limit, offset } = parsePagination(req.query);

    const notifications = await NotificationModel.getByUser(user_id, academic_year_id, { limit, offset });

    return res.status(200).json({ success: true, notifications });
  } catch (err) {
    console.error(err.message);
    return sendError(res, 500, "Failed to load notifications");
  }
}

async function getUnreadCount(req, res) {
  try {
    const { user_id, academic_year_id } = req.user;

    const count = await NotificationModel.getUnreadCount(user_id, academic_year_id);

    return res.status(200).json({ success: true, count });
  } catch (err) {
    console.error(err.message);
    return sendError(res, 500, "Failed to load unread count");
  }
}

async function markAsRead(req, res) {
  try {
    const { user_id } = req.user;
    const notifId = parseId(req.params.id);

    if (!notifId) {
      return sendError(res, 400, "Invalid notification id");
    }

    const updated = await NotificationModel.markAsRead(notifId, user_id);

    if (!updated) {
      return sendError(res, 404, "Notification not found");
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err.message);
    return sendError(res, 500, "Failed to mark notification as read");
  }
}

async function markAllAsRead(req, res) {
  try {
    const { user_id, academic_year_id } = req.user;

    await NotificationModel.markAllAsRead(user_id, academic_year_id);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err.message);
    return sendError(res, 500, "Failed to mark notifications as read");
  }
}

async function deleteNotification(req, res) {
  try {
    const { user_id } = req.user;
    const notifId = parseId(req.params.id);

    if (!notifId) {
      return sendError(res, 400, "Invalid notification id");
    }

    const deleted = await NotificationModel.deleteNotification(notifId, user_id);

    if (!deleted) {
      return sendError(res, 404, "Notification not found");
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err.message);
    return sendError(res, 500, "Failed to delete notification");
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};