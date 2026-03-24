const db = require("../config/db");
const bcrypt = require("bcryptjs");

exports.changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({
      success: false,
      message: "Both current and new password are required",
    });
  }

  try {

    const [rows] = await db.query(
      "SELECT password FROM users WHERE user_id = ?",
      [req.user.user_id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false });
    }

    const user = rows[0];

    const match = await bcrypt.compare(current_password, user.password);

    if (!match) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const hashed = await bcrypt.hash(new_password, 10);

    await db.query(
      "UPDATE users SET password = ? WHERE user_id = ?",
      [hashed, req.user.user_id]
    );

    res.json({
      success: true,
      message: "Password updated successfully",
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};