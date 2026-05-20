const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "Asia/Manila",
    hour12: false
  });
}

class AttendanceModel {

  // =========================
  // ACTIVE ATTENDANCE
  // =========================
  static async getActiveAttendance(student_id) {

  const [[row]] = await db.query(`
    SELECT *
    FROM attendance
    WHERE student_id = ?
    AND attendance_date = CURDATE()
    AND (
      time_out IS NULL
      OR (
        ot_time_in IS NOT NULL
        AND ot_time_out IS NULL
      )
    )
    ORDER BY attendance_id DESC
    LIMIT 1
  `, [student_id]);

  return row || null;
}

  // =========================
  // STUDENT ATTENDANCE
  // =========================
  static async getByStudent(student_id) {

    const [rows] = await db.query(`
      SELECT 
        attendance_id,
        student_id,
        attendance_date,

        time_in,
        lunch_break_start,
        lunch_break_end,
        time_out,

        ot_time_in,
        ot_time_out,

        latitude,
        longitude,

        location_status,
        coordinator_note,
        created_at

      FROM attendance

      WHERE student_id = ?

      ORDER BY attendance_date DESC,
               attendance_id DESC
    `, [student_id]);

    return rows;
  }

  // =========================
  // BY DEPARTMENT
  // =========================
  static async getByDepartment(department_id) {

    let sql = `
      SELECT
        a.attendance_id,
        a.student_id,
        a.attendance_date,

        a.time_in,
        a.lunch_break_start,
        a.lunch_break_end,
        a.time_out,

        a.ot_time_in,
        a.ot_time_out,

        a.latitude,
        a.longitude,

        a.location_status,
        a.coordinator_note,

        u.f_name,
        u.l_name,
        u.photo,

        s.start_time,
        s.end_time

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      JOIN users u
        ON s.user_id = u.user_id

      JOIN courses c
        ON s.course_id = c.course_id
    `;

    if (department_id) {

      sql += `
        WHERE c.department_id = ?
      `;

      return (await db.query(sql, [department_id]))[0];
    }

    return (await db.query(sql))[0];
  }

  // =========================
  // CHECK IF LUNCH REQUIRED
  // =========================
  static async requiresLunch(student_id) {

    const [[student]] = await db.query(`
      SELECT start_time, end_time
      FROM students
      WHERE student_id = ?
      LIMIT 1
    `, [student_id]);

    if (!student?.start_time || !student?.end_time) {
      return true;
    }

    const [hoursRow] = await db.query(`
      SELECT
        (
          TIME_TO_SEC(
            TIMEDIFF(
              ?,
              ?
            )
          ) / 3600
        ) AS shift_hours
    `, [
      student.end_time,
      student.start_time
    ]);

    let shiftHours = Number(hoursRow?.[0]?.shift_hours || 0);

    // night shift correction
    if (shiftHours < 0) {
      shiftHours += 24;
    }

    return shiftHours >= 5;
  }

  // =========================
  // TIME IN / START OT
  // =========================
  static async timeIn({ student_id, latitude, longitude }) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id);

    // =========================
    // LOCATION CHECK
    // =========================
    let location_status = "flagged";

    if (latitude && longitude) {

      const [[location]] = await db.query(`
        SELECT latitude, longitude, radius_meters
        FROM students s
        JOIN ojt_locations l
          ON s.company_id = l.company_id
        WHERE s.student_id = ?
        LIMIT 1
      `, [student_id]);

      if (location) {

        const [[distanceResult]] = await db.query(`
          SELECT (
            6371000 * ACOS(
              COS(RADIANS(?)) *
              COS(RADIANS(?)) *
              COS(RADIANS(?) - RADIANS(?)) +
              SIN(RADIANS(?)) *
              SIN(RADIANS(?))
            )
          ) AS distance
        `, [
          latitude,
          location.latitude,
          location.longitude,
          longitude,
          latitude,
          location.latitude
        ]);

        if ((distanceResult.distance || 999999)
          <= location.radius_meters) {

          location_status = "verified";
        }
      }
    }

    // =========================
    // FIRST TIME IN
    // =========================
    if (!active) {

      const [result] = await db.query(`
        INSERT INTO attendance (
          student_id,
          attendance_date,

          time_in,

          latitude,
          longitude,

          location_status
        )
        VALUES (
          ?,
          CURDATE(),
          ?,
          ?,
          ?,
          ?
        )
      `, [
        student_id,
        now,
        latitude ?? null,
        longitude ?? null,
        location_status
      ]);

      return result.insertId;
    }

    // =========================
    // BLOCK DUPLICATE TIME IN
    // =========================
    if (active.time_in && !active.time_out) {
      throw new Error("Already timed in");
    }

    // =========================
    // START OT
    // =========================
    if (
      active.time_out &&
      !active.ot_time_in
    ) {

      await db.query(`
        UPDATE attendance
        SET ot_time_in = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      return;
    }

    // =========================
    // BLOCK DUPLICATE OT
    // =========================
    if (
      active.ot_time_in &&
      !active.ot_time_out
    ) {
      throw new Error("OT already started");
    }

    throw new Error("Attendance already completed");
  }

  // =========================
  // START LUNCH
  // =========================
  static async startLunchBreak(student_id) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(student_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.time_in) {
      throw new Error("Time in first");
    }

    if (active.time_out) {
      throw new Error("Already timed out");
    }

    const requiresLunch =
      await this.requiresLunch(student_id);

    if (!requiresLunch) {
      throw new Error(
        "Lunch break not required for this shift"
      );
    }

    if (active.lunch_break_start) {
      throw new Error(
        "Lunch break already started"
      );
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_start = ?
      WHERE attendance_id = ?
    `, [
      now,
      active.attendance_id
    ]);
  }

  // =========================
  // END LUNCH
  // =========================
  static async endLunchBreak(student_id) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(student_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.lunch_break_start) {
      throw new Error(
        "Lunch break not started"
      );
    }

    if (active.lunch_break_end) {
      throw new Error(
        "Lunch break already ended"
      );
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_end = ?
      WHERE attendance_id = ?
    `, [
      now,
      active.attendance_id
    ]);
  }

  // =========================
  // TIME OUT / END OT
  // =========================
  static async timeOutByStudent(student_id) {

    const now = getPHTime();

    const active =
      await this.getActiveAttendance(student_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    // =========================
    // REGULAR TIME OUT
    // =========================
    if (
      active.time_in &&
      !active.time_out
    ) {

      await db.query(`
        UPDATE attendance
        SET time_out = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      await this.checkCompletionAndNotify(
        student_id
      );

      return;
    }

    // =========================
    // END OT
    // =========================
    if (
      active.ot_time_in &&
      !active.ot_time_out
    ) {

      await db.query(`
        UPDATE attendance
        SET ot_time_out = ?
        WHERE attendance_id = ?
      `, [
        now,
        active.attendance_id
      ]);

      await this.checkCompletionAndNotify(
        student_id
      );

      return;
    }

    throw new Error(
      "Attendance already completed"
    );
  }

  // =========================
  // HOURS COMPUTATION
  // =========================
  static async getHoursByStudent(student_id) {

    const [[row]] = await db.query(`
      SELECT
        IFNULL(
          SUM(
            (
              (
                IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(time_out, time_in)
                  ),
                  0
                )

                - IF(
                    lunch_break_start IS NOT NULL
                    AND lunch_break_end IS NOT NULL,

                    TIME_TO_SEC(
                      TIMEDIFF(
                        lunch_break_end,
                        lunch_break_start
                      )
                    ),

                    IF(
                      IFNULL(
                        TIME_TO_SEC(
                          TIMEDIFF(
                            time_out,
                            time_in
                          )
                        ),
                        0
                      ) >= 18000,
                      3600,
                      0
                    )
                  )
              )

              + IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(
                      ot_time_out,
                      ot_time_in
                    )
                  ),
                  0
                )
            ) / 3600
          ),
          0
        ) AS hours

      FROM attendance

      WHERE student_id = ?
      AND time_in IS NOT NULL
      AND time_out IS NOT NULL
    `, [student_id]);

    return row.hours || 0;
  }

  // =========================
  // COMPLETION CHECK
  // =========================
  static async checkCompletionAndNotify(student_id) {

    const [[row]] = await db.query(`
      SELECT
        s.user_id,

        s.ojt_hours_required
          AS required_hours,

        IFNULL(
          SUM(
            (
              (
                IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(
                      a.time_out,
                      a.time_in
                    )
                  ),
                  0
                )

                - IF(
                    a.lunch_break_start
                      IS NOT NULL
                    AND
                    a.lunch_break_end
                      IS NOT NULL,

                    TIME_TO_SEC(
                      TIMEDIFF(
                        a.lunch_break_end,
                        a.lunch_break_start
                      )
                    ),

                    IF(
                      IFNULL(
                        TIME_TO_SEC(
                          TIMEDIFF(
                            a.time_out,
                            a.time_in
                          )
                        ),
                        0
                      ) >= 18000,
                      3600,
                      0
                    )
                  )
              )

              + IFNULL(
                  TIME_TO_SEC(
                    TIMEDIFF(
                      a.ot_time_out,
                      a.ot_time_in
                    )
                  ),
                  0
                )
            ) / 3600
          ),
          0
        ) AS completed_hours

      FROM students s

      LEFT JOIN attendance a
        ON s.student_id = a.student_id

      WHERE s.student_id = ?

      GROUP BY
        s.user_id,
        s.ojt_hours_required
    `, [student_id]);

    if (!row) return;

    if (
      row.completed_hours
      < row.required_hours
    ) {
      return;
    }

    const [[existing]] = await db.query(`
      SELECT notif_id
      FROM notifications
      WHERE user_id = ?
      AND title = 'OJT Completed'
      LIMIT 1
    `, [row.user_id]);

    if (existing) return;

    await sendNotification({
      user_id: row.user_id,
      title: "OJT Completed",
      message:
        "Congratulations! You have completed your required OJT hours.",
      type: "system",
      link: "/student/progress"
    });
  }

// =========================
// TODAY
// =========================
static async getToday(student_id) {

  const active =
    await this.getActiveAttendance(student_id);

  if (active) {

    const [[student]] = await db.query(`
      SELECT
        start_time,
        end_time
      FROM students
      WHERE student_id = ?
      LIMIT 1
    `, [student_id]);

    return {
      ...active,

      start_time:
        student?.start_time || null,

      end_time:
        student?.end_time || null
    };
  }

  const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    WHERE a.student_id = ?
    AND a.attendance_date = CURDATE()

    ORDER BY a.attendance_id DESC
    LIMIT 1
  `, [student_id]);

  return rows[0] || null;
}

  // =========================
// HISTORY
// =========================
static async getStudentHistory(student_id) {

  const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    WHERE a.student_id = ?

    ORDER BY
      a.attendance_date DESC,
      a.attendance_id DESC
  `, [student_id]);

  return rows;
}

  // =========================
  // UPDATE LOCATION STATUS
  // =========================
  static async updateLocationStatus(
    attendance_id,
    location_status
  ) {

    const [result] = await db.query(`
      UPDATE attendance
      SET location_status = ?
      WHERE attendance_id = ?
    `, [
      location_status,
      attendance_id
    ]);

    console.log(
      "Rows affected:",
      result.affectedRows
    );
  }
  // =========================
// COORDINATOR: STUDENT RECORDS
// =========================
static async getStudentAttendanceRecords(
  student_id
) {

  const [rows] = await db.query(`
    SELECT
      a.attendance_id,
      a.student_id,
      a.attendance_date,

      a.time_in,
      a.lunch_break_start,
      a.lunch_break_end,
      a.time_out,

      a.ot_time_in,
      a.ot_time_out,

      a.latitude,
      a.longitude,

      a.location_status,
      a.coordinator_note,

      u.f_name,
      u.l_name,
      u.photo,

      s.start_time,
      s.end_time

    FROM attendance a

    JOIN students s
      ON a.student_id = s.student_id

    JOIN users u
      ON s.user_id = u.user_id

    WHERE a.student_id = ?

    ORDER BY
      a.attendance_date DESC,
      a.attendance_id DESC
  `, [student_id]);

  return rows;
}
}

module.exports = AttendanceModel;