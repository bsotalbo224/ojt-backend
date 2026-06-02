const db = require("../config/db");

class AcademicYearModel {
  static async getAll() {
    const [rows] = await db.query(`
      SELECT *
      FROM academic_years
      ORDER BY start_date DESC
    `);

    return rows;
  }

  static async getActive() {
    const [[row]] = await db.query(`
      SELECT *
      FROM academic_years
      WHERE is_active = 1
      LIMIT 1
    `);

    return row;
  }

  static async create(data) {
    const {
      academic_year_name,
      start_date,
      end_date
    } = data;

    const [result] = await db.query(`
      INSERT INTO academic_years
      (
        academic_year_name,
        start_date,
        end_date
      )
      VALUES (?, ?, ?)
    `, [
      academic_year_name,
      start_date,
      end_date
    ]);

    return result.insertId;
  }

  static async setActive(id) {

    await db.query(`
      UPDATE academic_years
      SET is_active = 0
    `);

    await db.query(`
      UPDATE academic_years
      SET is_active = 1
      WHERE academic_year_id = ?
    `, [id]);

    return true;
  }
}

module.exports = AcademicYearModel;