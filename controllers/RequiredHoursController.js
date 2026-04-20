const db = require("../config/db");

class RequiredHoursController {

  // =========================
  // GET ALL OPTIONS
  // =========================
  static async getAll(req, res) {
    try {
      const [rows] = await db.query(
        `SELECT id, hours 
         FROM required_hours_options 
         ORDER BY hours ASC`
      );

      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // =========================
  // ADD NEW OPTION
  // =========================
  static async create(req, res) {
    try {
      const { hours } = req.body;

      // validation
      if (!hours || isNaN(hours) || hours <= 0) {
        return res.status(400).json({
          error: "Hours must be a positive number"
        });
      }

      const value = parseInt(hours);

      await db.query(
        `INSERT INTO required_hours_options (hours)
         VALUES (?)`,
        [value]
      );

      res.status(201).json({
        message: "Required hours option added",
        hours: value
      });

    } catch (err) {

      // duplicate handling
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({
          error: "This required hours value already exists"
        });
      }

      res.status(500).json({ error: err.message });
    }
  }

  // =========================
  // DELETE OPTION (optional)
  // =========================
  static async delete(req, res) {
    try {
      const { id } = req.params;

      await db.query(
        `DELETE FROM required_hours_options WHERE id = ?`,
        [id]
      );

      res.json({ message: "Deleted successfully" });

    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
}

module.exports = RequiredHoursController;