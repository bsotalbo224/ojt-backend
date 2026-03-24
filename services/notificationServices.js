const db = require("../config/db");

/**
 * Send system notification
 * Supports both:
 *  sendNotification(user_id, title, message)
 *  sendNotification({ user_id, title, message, type, link })
 */
async function sendNotification(arg1, arg2, arg3) {
  try {
    let user_id, title, message, type = null, link = null;

    // NEW OBJECT STYLE
    if (typeof arg1 === "object") {
      user_id = arg1.user_id;
      title = arg1.title;
      message = arg1.message;
      type = arg1.type || null;
      link = arg1.link || null;
    } 
    // OLD STYLE (backward compatible)
    else {
      user_id = arg1;
      title = arg2;
      message = arg3;
    }

    if (!user_id) return;

    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, link)
       VALUES (?, ?, ?, ?, ?)`,
      [user_id, title, message, type, link]
    );

  } catch (err) {
    console.error("SYSTEM NOTIFICATION ERROR:", err);
  }
}

module.exports = { sendNotification };