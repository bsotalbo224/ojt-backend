const db = require("../config/db");

class DepartmentModel {

  /* =========================
  HELPER: GENERATE CODE
  ========================= */
  static generateDeptCode(name) {
    if (!name) return "GEN";

    const words = name
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .trim()
      .split(/\s+/);

    if (words.length === 1) {
      return words[0].substring(0, 3).toUpperCase();
    }

    return words.map(w => w[0]).join("").toUpperCase();
  }

  /* =========================
  ALL
  ========================= */
static async getAll() {
  const [rows] = await db.query(`
    SELECT 
      d.department_id,
      d.department_code,
      d.department_name,
      COUNT(s.student_id) AS total_students
    FROM departments d
    LEFT JOIN courses c 
      ON c.department_id = d.department_id
    LEFT JOIN students s 
      ON s.course_id = c.course_id
    GROUP BY
      d.department_id,
      d.department_code,
      d.department_name
    ORDER BY d.department_name ASC
  `);

  return rows;
}

  /* =========================
  BY ID
  ========================= */
  static async getById(id) {
    const [[row]] = await db.query(`
      SELECT department_id, department_code, department_name, theme, logo
      FROM departments
      WHERE department_id = ?
    `, [id]);
    return row;
  }

  /* =========================
  CREATE
  ========================= */
  static async create(data) {
    const { department_name } = data;

    const department_code = this.generateDeptCode(department_name);
    console.log("Generated code:", department_code);

    const [result] = await db.query(`
      INSERT INTO departments (department_code, department_name)
      VALUES (?, ?)
    `, [department_code, department_name]);

    return result.insertId;
  }

  /* =========================
  UPDATE
  ========================= */
  static async update(id, data) {
    const { department_name } = data;

    const department_code = this.generateDeptCode(department_name);

    await db.query(`
      UPDATE departments
      SET department_code = ?, department_name = ?
      WHERE department_id = ?
    `, [department_code, department_name, id]);
  }

  /* =========================
  DELETE
  ========================= */
  static async delete(id) {
    await db.query(
      `DELETE FROM departments WHERE department_id = ?`,
      [id]
    );
  }

  /* =========================
 GET ALL (FOR THEME SETTINGS)
========================= */
static async getAllWithTheme() {
  const [rows] = await db.query(`
    SELECT 
      department_id,
      department_name,
      department_code,
      theme,
      logo
    FROM departments
    ORDER BY department_name ASC
  `);

  return rows;
}
/* =========================
UPDATE THEME
========================= */
static async updateTheme(department_id, theme) {
  await db.query(
    `UPDATE departments SET theme = ? WHERE department_id = ?`,
    [theme, department_id]
  );
}
/* =========================
UPDATE LOGO
========================= */
static async updateLogo(department_id, logo) {
  await db.query(
    `UPDATE departments SET logo = ? WHERE department_id = ?`,
    [logo, department_id]
  );
}

}



module.exports = DepartmentModel;