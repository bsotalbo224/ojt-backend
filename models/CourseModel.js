const db = require("../config/db");

class CourseModel {

  // =========================
  // ALL COURSES (admin)
  // =========================
  static async getAll() {
    const [rows] = await db.query(`
      SELECT 
        c.course_id,
        c.course_code,
        c.course_name,
        c.department_id,
        c.required_hours,
        d.department_name
      FROM courses c
      LEFT JOIN departments d 
        ON c.department_id = d.department_id
      ORDER BY c.course_name ASC
    `);

    return rows;
  }

  // =========================
  // COURSES BY DEPARTMENT
  // =========================
  static async getByDepartment(department_id) {
    const [rows] = await db.query(`
      SELECT 
        course_id,
        course_code,
        course_name,
        department_id,
        required_hours
      FROM courses
      WHERE department_id = ?
      ORDER BY course_name ASC
    `, [department_id]);

    return rows;
  }

  // =========================
  // SINGLE COURSE
  // =========================
  static async getById(course_id) {
    const [[row]] = await db.query(`
      SELECT 
        course_id,
        course_code,
        course_name,
        department_id,
        required_hours
      FROM courses
      WHERE course_id = ?
    `, [course_id]);

    return row;
  }

  // =========================
  // CREATE COURSE (admin)
  // =========================
  static async create(data) {
    const { course_code, course_name, department_id, required_hours } = data;

    const [result] = await db.query(`
      INSERT INTO courses
      (course_code, course_name, department_id, required_hours)
      VALUES (?, ?, ?, ?)
    `, [course_code, course_name, department_id, required_hours]);

    return result.insertId;
  }

  // =========================
  // UPDATE COURSE (admin)
  // =========================
  static async update(course_id, data) {
    const { course_code, course_name, department_id, required_hours } = data;

    await db.query(`
      UPDATE courses
      SET course_code = ?, course_name = ?, department_id = ?, required_hours = ?
      WHERE course_id = ?
    `, [course_code, course_name, department_id, required_hours, course_id]);
  }

  // =========================
  // DELETE COURSE (admin)
  // =========================
  static async delete(course_id) {
    await db.query(
      `DELETE FROM courses WHERE course_id = ?`,
      [course_id]
    );
  }
}

module.exports = CourseModel;
