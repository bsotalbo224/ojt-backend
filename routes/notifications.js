const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { requireAuth } = require("../middleware/authMiddleware");

// ===============================
// GET notifications for user
// ===============================
router.get("/", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.user_id;

    const [notifs] = await db.query(
      `SELECT * 
       FROM notifications 
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [user_id]
    );

    res.json({ success: true, notifications: notifs });

  } catch (err) {
    console.error("NOTIF FETCH ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ===============================
// SEND NOTIFICATION (system/admin)
// ===============================
router.post("/", requireAuth, async (req, res) => {
  try {
    const { user_id, title, message } = req.body;

    const [result] = await db.query(
      `INSERT INTO notifications (user_id, title, message)
       VALUES (?, ?, ?)`,
      [user_id, title, message]
    );

    res.json({
      success: true,
      notification_id: result.insertId
    });

  } catch (err) {
    console.error("NOTIF INSERT ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ===============================
// MARK READ
// ===============================
router.patch("/read/:notif_id", requireAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE notifications
       SET is_read = 1
       WHERE notif_id = ?`,
      [req.params.notif_id]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("NOTIF READ ERROR:", err);
    res.status(500).json({ success: false });
  }
});


// ===============================
// UNREAD COUNT
// ===============================
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    let user_id = req.user.user_id;

    // if student, convert student_id → user_id
    if (req.user.role === "student") {
      const [[row]] = await db.query(
        "SELECT user_id FROM students WHERE student_id=?",
        [req.user.id]
      );
      if (row) user_id = row.user_id;
    }

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE user_id = ?
       AND is_read = 0`,
      [user_id]
    );

    res.json({ success: true, count: countRow.count });

  } catch (err) {
    console.error("UNREAD COUNT ERROR:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;