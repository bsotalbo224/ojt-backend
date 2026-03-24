const db = require("../config/db");

async function archiveInactiveStudents() {
  try {
    const [students] = await db.query(`
      SELECT *
      FROM students
      WHERE is_active = 0
      AND inactive_since < NOW() - INTERVAL 180 DAY
    `);

    for (const student of students) {

      await db.query(`
        INSERT INTO students_archive
        SELECT *, NOW()
        FROM students
        WHERE student_id = ?
      `, [student.student_id]);

      await db.query(`
        DELETE FROM students
        WHERE student_id = ?
      `, [student.student_id]);
    }

    console.log("Archived inactive students:", students.length);

  } catch (err) {
    console.error("Archive job error:", err);
  }
}

module.exports = archiveInactiveStudents;