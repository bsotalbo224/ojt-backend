const db = require("../config/db");

const NOTIFICATION_EVENT = "notification:new";

const NotificationTypes = Object.freeze({
  SYSTEM: "system",
  ACCOUNT: "account",
  ATTENDANCE: "attendance",
  DAILY_LOG: "daily_log",
  NARRATIVE: "narrative",
  FEEDBACK: "feedback",
  PROGRESS: "progress",
  PLACEMENT: "placement",
  CONSULTATION: "consultation",
  EVALUATION: "evaluation",
  REMINDER: "reminder",
});

let io = null;

function setSocket(socketInstance) {
  if (io) return;
  io = socketInstance;
}

function normalizeNotification(userIdOrPayload, positionalTitle, positionalMessage) {
  if (typeof userIdOrPayload === "object" && userIdOrPayload !== null) {
    const payload = userIdOrPayload;
    return {
      user_id: payload.user_id,
      sender_id: payload.sender_id ?? null,
      reference_id: payload.reference_id ?? null,
      title: payload.title,
      message: payload.message,
      type: payload.type ?? null,
      link: payload.link ?? null,
      academic_year_id: payload.academic_year_id ?? null,
    };
  }

  return {
    user_id: userIdOrPayload,
    sender_id: null,
    reference_id: null,
    title: positionalTitle,
    message: positionalMessage,
    type: null,
    link: null,
    academic_year_id: null,
  };
}

function validateNotification(notification) {
  if (!notification.user_id) return false;

  const title = notification.title?.trim();
  const message = notification.message?.trim();

  if (!title || !message) return false;

  notification.title = title;
  notification.message = message;
  return true;
}

async function insertNotification(notification) {
  const [result] = await db.query(
    `INSERT INTO notifications (
      user_id, sender_id, reference_id, title, message, type, link, academic_year_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      notification.user_id,
      notification.sender_id,
      notification.reference_id,
      notification.title,
      notification.message,
      notification.type,
      notification.link,
      notification.academic_year_id,
    ]
  );

  return {
    notif_id: result.insertId,
    user_id: notification.user_id,
    sender_id: notification.sender_id,
    reference_id: notification.reference_id,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    link: notification.link,
    academic_year_id: notification.academic_year_id,
    is_read: 0,
    created_at: new Date(),
  };
}

function emitNotification(notification) {
  if (!io) return;

  try {
    io.to(`user_${notification.user_id}`).emit(NOTIFICATION_EVENT, notification);
  } catch (err) {
    console.error("NOTIFICATION SOCKET EMIT ERROR:", err.message);
  }
}

async function sendNotification(userIdOrPayload, positionalTitle, positionalMessage) {
  const notification = normalizeNotification(userIdOrPayload, positionalTitle, positionalMessage);

  if (!validateNotification(notification)) {
    console.error("NOTIFICATION VALIDATION FAILED for user_id:", notification.user_id);
    return null;
  }

  try {
    const savedNotification = await insertNotification(notification);
    emitNotification(savedNotification);
    return savedNotification;
  } catch (err) {
    console.error("NOTIFICATION INSERT ERROR:", err.message);
    return null;
  }
}

module.exports = { sendNotification, setSocket, NotificationTypes };