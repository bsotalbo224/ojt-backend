const db = require("../config/db");
const { sendNotification } = require("../services/notificationServices");

function getPHTime() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "Asia/Manila",
    hour12: false
  });
}

// Safe numeric time comparison helper.
// Converts a "HH:MM" or "HH:MM:SS" string into total minutes so time
// values can be compared reliably instead of relying on string
// comparison (which breaks on inconsistent zero-padding/formats).
function toMinutes(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
}

// =========================
// EFFECTIVE TIME SQL FRAGMENT
// =========================
// Reusable CASE expression for computing the effective start time.
// Rules:
//   - early_attendance = 1 AND early_status = 'approved' -> use actual a.time_in
//   - time_in earlier than s.start_time (accounting for night shifts,
//     pending/rejected/any other status)              -> use s.start_time
//   - otherwise                                        -> use actual a.time_in
// Night-shift rule: start_time >= 18:00 AND time_in in 12:00-23:59 is
// considered early; time_in in 00:00-11:59 belongs to the next calendar
// day and is NOT treated as early.
// Requires attendance alias `a` and students alias `s` in scope.
const EFFECTIVE_TIME_IN_CASE = `
  CASE
    WHEN a.early_attendance = 1
     AND a.early_status = 'approved'
    THEN a.time_in
    WHEN (
      (
        s.start_time < '18:00:00'
        AND a.time_in < s.start_time
      )
      OR
      (
        s.start_time >= '18:00:00'
        AND a.time_in >= '12:00:00'
        AND a.time_in < s.start_time
      )
    )
    THEN s.start_time
    ELSE a.time_in
  END
`;

// =========================
// HOURS SUM SQL FRAGMENT
// =========================
// Full per-row hours expression (regular + OT, lunch-aware, overnight-safe).
//
// OVERNIGHT-SAFE: every duration is wrapped in a CASE that detects
// end < start and adds 24:00:00 via ADDTIME before diffing, so
// work hours, lunch breaks, and OT all compute correctly across midnight.
//
// LUNCH DEDUCTION:
//   - If both lunch_break_start and lunch_break_end exist -> deduct actual
//     lunch duration.
//   - If shift is >= 5 h (18000 s) and lunch times are missing -> deduct
//     1 h (3600 s) automatically.
//   - Short shifts (< 5 h) with no recorded lunch -> no deduction.
//
// Requires attendance alias `a` and students alias `s` in scope.
const HOURS_SUM_EXPR = `
  (
    (
      IFNULL(
        TIME_TO_SEC(
          CASE
            WHEN a.time_out < (${EFFECTIVE_TIME_IN_CASE})
            THEN TIMEDIFF(
              ADDTIME(a.time_out, '24:00:00'),
              (${EFFECTIVE_TIME_IN_CASE})
            )
            ELSE TIMEDIFF(
              a.time_out,
              (${EFFECTIVE_TIME_IN_CASE})
            )
          END
        ),
        0
      )

      - IF(
          a.lunch_break_start IS NOT NULL
          AND a.lunch_break_end IS NOT NULL,

          TIME_TO_SEC(
            CASE
              WHEN a.lunch_break_end < a.lunch_break_start
              THEN TIMEDIFF(
                ADDTIME(a.lunch_break_end, '24:00:00'),
                a.lunch_break_start
              )
              ELSE TIMEDIFF(
                a.lunch_break_end,
                a.lunch_break_start
              )
            END
          ),

          IF(
            IFNULL(
              TIME_TO_SEC(
                CASE
                  WHEN a.time_out < (${EFFECTIVE_TIME_IN_CASE})
                  THEN TIMEDIFF(
                    ADDTIME(a.time_out, '24:00:00'),
                    (${EFFECTIVE_TIME_IN_CASE})
                  )
                  ELSE TIMEDIFF(
                    a.time_out,
                    (${EFFECTIVE_TIME_IN_CASE})
                  )
                END
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
          CASE
            WHEN a.ot_time_out < a.ot_time_in
            THEN TIMEDIFF(
              ADDTIME(a.ot_time_out, '24:00:00'),
              a.ot_time_in
            )
            ELSE TIMEDIFF(
              a.ot_time_out,
              a.ot_time_in
            )
          END
        ),
        0
      )
  ) / 3600
`;

class AttendanceModel {

  // =========================
  // ACTIVE ATTENDANCE
  // =========================
  // Returns the most recent incomplete attendance record for a student.
  // "Incomplete" means either:
  //   (a) timed in but not yet timed out, OR
  //   (b) timed out but OT has started and not yet ended.
  //
  // attendance table has NO academic_year_id column.
  // Academic year is scoped via JOIN students s WHERE s.academic_year_id = ?.
  static async getActiveAttendance(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT a.*
      FROM attendance a
      JOIN students s
        ON a.student_id = s.student_id
      WHERE a.student_id = ?
        AND s.academic_year_id = ?
        AND (
          a.time_out IS NULL
          OR (
            a.time_out IS NOT NULL
            AND a.ot_time_in IS NOT NULL
            AND a.ot_time_out IS NULL
          )
        )
      ORDER BY a.attendance_id DESC
      LIMIT 1
    `, [student_id, academic_year_id]);

    return row || null;
  }

  // =========================
  // STUDENT ATTENDANCE
  // =========================
  // Returns all attendance records for a student in an academic year.
  // attendance table has NO academic_year_id; filtered via students join.
  static async getByStudent(student_id, academic_year_id) {

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
        a.created_at

      FROM attendance a
      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
        AND s.academic_year_id = ?

      ORDER BY
        a.attendance_date DESC,
        a.attendance_id DESC
    `, [student_id, academic_year_id]);

    return rows;
  }

  // =========================
  // BY DEPARTMENT
  // =========================
  // Returns all attendance records for students in a given department
  // and academic year.
  //
  // Department is sourced from students.department_id — this is the
  // single source of truth for department filtering. There is no join
  // to the courses table, so department membership can never be derived
  // or overridden through course data.
  //
  // attendance table has NO academic_year_id; filtered via students join.
  static async getByDepartment(department_id, academic_year_id) {

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
    `;

    if (department_id) {
      sql += `
        WHERE s.department_id = ?
          AND s.academic_year_id = ?
      `;
      return (await db.query(sql, [department_id, academic_year_id]))[0];
    }

    sql += `
      WHERE s.academic_year_id = ?
    `;
    return (await db.query(sql, [academic_year_id]))[0];
  }

  // =========================
  // CHECK IF LUNCH REQUIRED
  // =========================
  // Returns true if the student's shift is 5 or more hours long,
  // meaning a lunch break is expected.
  // Handles night shifts (negative TIMEDIFF corrected by adding 24 h).
  static async requiresLunch(student_id, academic_year_id) {

    const [[student]] = await db.query(`
      SELECT start_time, end_time
      FROM students
      WHERE student_id = ?
        AND academic_year_id = ?
      LIMIT 1
    `, [student_id, academic_year_id]);

    if (!student?.start_time || !student?.end_time) {
      return true;
    }

    const [hoursRow] = await db.query(`
      SELECT (
        TIME_TO_SEC(
          TIMEDIFF(?, ?)
        ) / 3600
      ) AS shift_hours
    `, [student.end_time, student.start_time]);

    let shiftHours = Number(hoursRow?.[0]?.shift_hours || 0);

    // Night shift correction: if end_time < start_time, TIMEDIFF is
    // negative; adding 24 gives the correct duration.
    if (shiftHours < 0) {
      shiftHours += 24;
    }

    return shiftHours >= 5;
  }

  // =========================
  // TIME IN / START OT
  // =========================
  static async timeIn({
    student_id,
    academic_year_id,
    latitude,
    longitude,
    early_reason,
    early_attachment_url,
    early_attachment_public_id,
    early_attachment_name
  }) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    // =========================
    // LOCATION CHECK
    // =========================
    let location_status = "flagged";

    if (latitude !== undefined && longitude !== undefined) {

      const [[location]] = await db.query(`
        SELECT l.latitude, l.longitude, l.radius_meters
        FROM students s
        JOIN ojt_locations l
          ON s.company_id = l.company_id
        WHERE s.student_id = ?
          AND s.academic_year_id = ?
        LIMIT 1
      `, [student_id, academic_year_id]);

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

        if ((distanceResult.distance || 999999) <= location.radius_meters) {
          location_status = "verified";
        }
      }
    }

    // =========================
    // EARLY ATTENDANCE CHECK (only for first time in)
    // =========================
    // No threshold: ANY time_in earlier than start_time is early.
    // Shift-aware: night shifts (start_time >= 6 PM) roll over past
    // midnight, so a time_in in the early-morning hours (12:00 AM-11:59 AM)
    // belongs to the shift that already started the previous evening and
    // must NOT be flagged as early.
    let early_attendance = false;
    let early_status = null;
    let early_reason_to_store = null;

    if (!active) {
      const [[student]] = await db.query(`
        SELECT start_time
        FROM students
        WHERE student_id = ?
          AND academic_year_id = ?
        LIMIT 1
      `, [student_id, academic_year_id]);

      if (student?.start_time) {
        const scheduleMinutes = toMinutes(student.start_time);
        const currentMinutes = toMinutes(now);

        // Night shift = scheduled start at or after 6:00 PM (18 * 60).
        const isNightShift = scheduleMinutes >= 18 * 60;

        let isEarly = false;

        if (isNightShift) {
          // 12:00 AM–11:59 AM belongs to the next calendar day and must
          // NOT be flagged as early for a night shift.
          if (currentMinutes >= 0 && currentMinutes < 12 * 60) {
            isEarly = false;
          } else {
            isEarly = currentMinutes < scheduleMinutes;
          }
        } else {
          // Day shift: any time_in before start_time is early.
          isEarly = currentMinutes < scheduleMinutes;
        }

        if (isEarly) {
          if (!early_reason) {
            throw new Error("Reason is required for early attendance.");
          }
          if (!early_attachment_url) {
            throw new Error("Attachment is required for early attendance.");
          }
          early_attendance = true;
          early_status = "pending";
          early_reason_to_store = early_reason;
        }
      }
    }

    // =========================
    // FIRST TIME IN
    // =========================
    // attendance table has NO academic_year_id column — do not insert it.
    if (!active) {

      const [result] = await db.query(`
        INSERT INTO attendance (
          student_id,
          attendance_date,
          time_in,
          latitude,
          longitude,
          location_status,
          early_attendance,
          early_reason,
          early_status,
          early_attachment_url,
          early_attachment_public_id,
          early_attachment_name
        )
        VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        student_id,
        now,
        latitude ?? null,
        longitude ?? null,
        location_status,
        early_attendance,
        early_reason_to_store,
        early_status,
        early_attachment_url ?? null,
        early_attachment_public_id ?? null,
        early_attachment_name ?? null
      ]);

      // =========================
      // NOTIFY COORDINATOR IF EARLY
      // =========================
      // coordinators table has NO academic_year_id column, so it is never
      // filtered or joined on academic year — only on department_id.
      //
      // There is exactly ONE coordinator per department, so joining
      // coordinators on s.department_id = c.department_id can match at
      // most one coordinator row per student. Combined with s.student_id = ?
      // (which already pins the query to a single student/department),
      // this join is structurally incapable of producing duplicate rows,
      // so no DISTINCT or GROUP BY is needed. LIMIT 1 is left in place as
      // a defensive guard only, not because duplicates are expected.
      if (early_attendance) {
        try {
          const [[studentInfo]] = await db.query(`
            SELECT
              u.f_name,
              u.l_name,
              s.start_time,
              cu.user_id AS coordinator_user_id
            FROM students s
            JOIN users u
              ON s.user_id = u.user_id
            JOIN coordinators c
              ON s.department_id = c.department_id
            JOIN users cu
              ON c.user_id = cu.user_id
            WHERE s.student_id = ?
              AND s.academic_year_id = ?
            LIMIT 1
          `, [student_id, academic_year_id]);

          if (studentInfo?.coordinator_user_id) {
            const formatTime = (timeStr) => {
              if (!timeStr) return "N/A";
              const [h, m] = timeStr.split(":").map(Number);
              const period = h >= 12 ? "PM" : "AM";
              const hour = h % 12 || 12;
              return `${hour}:${String(m).padStart(2, "0")} ${period}`;
            };

            const fullName = `${studentInfo.f_name} ${studentInfo.l_name}`;
            const timeInFormatted = formatTime(now);
            const scheduledFormatted = formatTime(studentInfo.start_time);

            await sendNotification({
              user_id: studentInfo.coordinator_user_id,
              title: "Early Attendance Request",
              message: `${fullName} submitted an early attendance request.\nTime In: ${timeInFormatted}\nScheduled Start: ${scheduledFormatted}`,
              type: "system",
              link: "/coordinator/attendance",
              academic_year_id
            });
          }
        } catch (error) {
          console.error("Early attendance notification failed:", error);
        }
      }

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
    if (active.time_out && !active.ot_time_in) {
      await db.query(`
        UPDATE attendance
        SET ot_time_in = ?
        WHERE attendance_id = ?
      `, [now, active.attendance_id]);

      return;
    }

    // =========================
    // BLOCK DUPLICATE OT
    // =========================
    if (active.ot_time_in && !active.ot_time_out) {
      throw new Error("OT already started");
    }

    throw new Error("Attendance already completed");
  }

  // =========================
  // START LUNCH
  // =========================
  static async startLunchBreak(student_id, academic_year_id) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.time_in) {
      throw new Error("Time in first");
    }

    if (active.time_out) {
      throw new Error("Already timed out");
    }

    const requiresLunch = await this.requiresLunch(student_id, academic_year_id);

    if (!requiresLunch) {
      throw new Error("Lunch break not required for this shift");
    }

    if (active.lunch_break_start) {
      throw new Error("Lunch break already started");
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_start = ?
      WHERE attendance_id = ?
    `, [now, active.attendance_id]);
  }

  // =========================
  // END LUNCH
  // =========================
  static async endLunchBreak(student_id, academic_year_id) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    if (!active.lunch_break_start) {
      throw new Error("Lunch break not started");
    }

    if (active.lunch_break_end) {
      throw new Error("Lunch break already ended");
    }

    await db.query(`
      UPDATE attendance
      SET lunch_break_end = ?
      WHERE attendance_id = ?
    `, [now, active.attendance_id]);
  }

  // =========================
  // TIME OUT / END OT
  // =========================
  static async timeOutByStudent(student_id, academic_year_id) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    // =========================
    // REGULAR TIME OUT
    // =========================
    if (active.time_in && !active.time_out) {
      await db.query(`
        UPDATE attendance
        SET time_out = ?
        WHERE attendance_id = ?
      `, [now, active.attendance_id]);

      await this.checkCompletionAndNotify(student_id, academic_year_id);
      return;
    }

    // =========================
    // END OT
    // =========================
    if (active.ot_time_in && !active.ot_time_out) {
      await db.query(`
        UPDATE attendance
        SET ot_time_out = ?
        WHERE attendance_id = ?
      `, [now, active.attendance_id]);

      await this.checkCompletionAndNotify(student_id, academic_year_id);
      return;
    }

    throw new Error("Attendance already completed");
  }

  // =========================
  // HOURS COMPUTATION
  // =========================
  // Computes total verified hours for a student in an academic year.
  //
  // EFFECTIVE TIME RULE (see EFFECTIVE_TIME_IN_CASE above):
  //   approved early          -> actual time_in counts
  //   pending/rejected early  -> start_time used instead of time_in
  //   on-time                 -> actual time_in counts
  //
  // Only location_status = 'verified' rows count.
  // attendance table has NO academic_year_id; filtered via students join.
  static async getHoursByStudent(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT
        IFNULL(
          SUM(${HOURS_SUM_EXPR}),
          0
        ) AS hours

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
        AND s.academic_year_id = ?
        AND a.time_in IS NOT NULL
        AND a.time_out IS NOT NULL
        AND a.location_status = 'verified'
    `, [student_id, academic_year_id]);

    return row.hours || 0;
  }

  // =========================
  // COMPLETION CHECK
  // =========================
  // Checks whether a student has met their required OJT hours and, if so,
  // sends a one-time completion notification (guarded by a duplicate check).
  //
  // Uses the same EFFECTIVE TIME RULE and overnight-safe duration logic
  // as getHoursByStudent(). Only location_status = 'verified' rows count.
  //
  // attendance table has NO academic_year_id; scoped via students join
  // and the LEFT JOIN ON condition.
  static async checkCompletionAndNotify(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT
        s.user_id,
        s.ojt_hours_required AS required_hours,

        IFNULL(
          SUM(${HOURS_SUM_EXPR}),
          0
        ) AS completed_hours

      FROM students s

      LEFT JOIN attendance a
        ON a.student_id = s.student_id
       AND a.location_status = 'verified'
       AND a.time_in IS NOT NULL
       AND a.time_out IS NOT NULL

      WHERE s.student_id = ?
        AND s.academic_year_id = ?

      GROUP BY
        s.user_id,
        s.ojt_hours_required
    `, [student_id, academic_year_id]);

    if (!row) return;

    if (row.completed_hours < row.required_hours) return;

    const [[existing]] = await db.query(`
      SELECT notif_id
      FROM notifications
      WHERE user_id = ?
        AND title = 'OJT Completed'
        AND academic_year_id = ?
      LIMIT 1
    `, [row.user_id, academic_year_id]);

    if (existing) return;

    await sendNotification({
      user_id: row.user_id,
      title: "OJT Completed",
      message: "Congratulations! You have completed your required OJT hours.",
      type: "system",
      link: "/student/progress",
      academic_year_id
    });
  }

  // =========================
  // TODAY
  // =========================
  // Returns the student's most recent attendance record (active or last
  // completed), enriched with display_time_in per the EFFECTIVE TIME RULE.
  //
  // attendance table has NO academic_year_id; filtered via students join.
  static async getToday(student_id, academic_year_id) {

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (active) {
      const [[student]] = await db.query(`
        SELECT start_time, end_time
        FROM students
        WHERE student_id = ?
          AND academic_year_id = ?
        LIMIT 1
      `, [student_id, academic_year_id]);

      const isApproved =
        active.early_attendance &&
        active.early_status === "approved";

      let isEarlierThanStart = false;

      if (student?.start_time && active.time_in) {
        const startMinutes = toMinutes(student.start_time);
        const timeInMinutes = toMinutes(active.time_in);
        const isNightShift = startMinutes >= 18 * 60;

        if (isNightShift) {
          // 12:00 AM–11:59 AM is next-calendar-day, not early for night shift.
          if (timeInMinutes >= 12 * 60 && timeInMinutes < startMinutes) {
            isEarlierThanStart = true;
          }
        } else {
          if (timeInMinutes < startMinutes) {
            isEarlierThanStart = true;
          }
        }
      }

      const display_time_in =
        isApproved
          ? active.time_in
          : isEarlierThanStart
            ? student.start_time
            : active.time_in;

      return {
        ...active,
        start_time: student?.start_time || null,
        end_time: student?.end_time || null,
        display_time_in
      };
    }

    // No active session — return the most recent completed record.
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

        a.early_attendance,
        a.early_reason,
        a.early_status,
        a.early_attachment_url,
        a.early_attachment_public_id,
        a.early_attachment_name,

        ${EFFECTIVE_TIME_IN_CASE} AS display_time_in,

        s.start_time,
        s.end_time

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
        AND s.academic_year_id = ?

      ORDER BY a.attendance_id DESC
      LIMIT 1
    `, [student_id, academic_year_id]);

    return rows[0] || null;
  }

  // =========================
  // HISTORY (PAGINATED)
  // =========================
  // Returns verified attendance records for the student, newest first.
  // location_status = 'flagged' rows are excluded from student-facing history.
  // attendance table has NO academic_year_id; filtered via students join.
  static async getStudentHistory(
    student_id,
    academic_year_id,
    page = 1,
    limit = 15
  ) {

    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 100);
    const offset = (safePage - 1) * safeLimit;

    const [[countRow]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM attendance a
      JOIN students s
        ON a.student_id = s.student_id
      WHERE a.student_id = ?
        AND s.academic_year_id = ?
        AND a.location_status = 'verified'
    `, [student_id, academic_year_id]);

    const total = countRow?.total || 0;

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

        a.early_attendance,
        a.early_reason,
        a.early_status,
        a.early_attachment_url,
        a.early_attachment_public_id,
        a.early_attachment_name,

        ${EFFECTIVE_TIME_IN_CASE} AS display_time_in,

        s.start_time,
        s.end_time

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
        AND s.academic_year_id = ?
        AND a.location_status = 'verified'

      ORDER BY
        a.attendance_date DESC,
        a.attendance_id DESC
      LIMIT ? OFFSET ?
    `, [student_id, academic_year_id, safeLimit, offset]);

    return {
      data: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
        hasMore: safePage * safeLimit < total
      }
    };
  }

  // =========================
  // HISTORY (FULL, UNPAGINATED — FOR EXPORT)
  // =========================
  // Returns all verified attendance records for export (e.g. Excel/PDF).
  // location_status = 'flagged' rows are excluded.
  // attendance table has NO academic_year_id; filtered via students join.
  static async getStudentHistoryForExport(student_id, academic_year_id) {

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

        a.early_attendance,
        a.early_reason,
        a.early_status,
        a.early_attachment_url,
        a.early_attachment_public_id,
        a.early_attachment_name,

        ${EFFECTIVE_TIME_IN_CASE} AS display_time_in,

        s.start_time,
        s.end_time

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      WHERE a.student_id = ?
        AND s.academic_year_id = ?
        AND a.location_status = 'verified'

      ORDER BY
        a.attendance_date DESC,
        a.attendance_id DESC
    `, [student_id, academic_year_id]);

    return rows;
  }

  // =========================
  // UPDATE LOCATION STATUS
  // =========================
  // Direct update by attendance_id — no academic_year_id needed here
  // since attendance_id is already unique.
  static async updateLocationStatus(
    attendance_id,
    location_status,
    academic_year_id,
    department_id
  ) {

    const [result] = await db.query(`
    UPDATE attendance a
    JOIN students s
      ON a.student_id = s.student_id
    SET a.location_status = ?
    WHERE a.attendance_id = ?
      AND s.academic_year_id = ?
      AND s.department_id = ?
    `, [
      location_status,
      attendance_id,
      academic_year_id,
      department_id
    ]);

    if (result.affectedRows === 0) {
      throw new Error("Attendance not found or unauthorized");
    }
    console.log("Rows affected:", result.affectedRows);
  }

  // =========================
  // COORDINATOR: STUDENT RECORDS
  // =========================
  // Returns raw, real attendance data for coordinator/admin review.
  // Includes actual time_in and full early-request details — NOT
  // adjusted by the display/effective-time rules used in student views.
  //
  // attendance table has NO academic_year_id; filtered via students join.
  //
  // department_id is OPTIONAL:
  //   - Coordinator request -> pass the coordinator's department_id so
  //     the query is restricted with s.department_id = ?, preventing a
  //     coordinator from Department A from pulling records for a
  //     student_id belonging to Department B.
  //   - Admin request -> pass null (default) to skip the department
  //     filter entirely and allow access across all departments.
  static async getStudentAttendanceRecords(
    student_id,
    academic_year_id,
    department_id = null
  ) {

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

        a.early_attendance,
        a.early_reason,
        a.early_status,
        a.early_attachment_url,
        a.early_attachment_public_id,
        a.early_attachment_name,

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
        AND s.academic_year_id = ?
    `;

    const params = [student_id, academic_year_id];

    if (department_id !== null) {
      sql += ` AND s.department_id = ? `;
      params.push(department_id);
    }

    sql += `
      ORDER BY
        a.attendance_date DESC,
        a.attendance_id DESC
    `;

    const [rows] = await db.query(sql, params);

    return rows;
  }

  // =========================
  // EARLY ATTENDANCE COORDINATOR METHODS
  // =========================

  // Approves a pending early attendance request.
  //
  // Ownership is validated by joining attendance -> students and checking
  // s.department_id = ?, ensuring coordinators can only approve records
  // belonging to students in their own department.
  //
  // Only transitions from 'pending' are allowed (AND a.early_status = 'pending').
  // This prevents double-approval and approve-after-reject.
  //
  // attendance table has NO academic_year_id; filtered via students join
  // (s.academic_year_id = ?).
  // coordinators table has NO academic_year_id — do not reference it here.
  static async approveEarlyAttendance(
    attendance_id,
    academic_year_id,
    department_id
  ) {
    const [result] = await db.query(`
      UPDATE attendance a
      JOIN students s
        ON a.student_id = s.student_id
      SET a.early_status = 'approved'
      WHERE a.attendance_id = ?
        AND s.academic_year_id = ?
        AND s.department_id = ?
        AND a.early_status = 'pending'
    `, [attendance_id, academic_year_id, department_id]);

    if (result.affectedRows === 0) {
      throw new Error("Early attendance request is already processed or not found");
    }

    return { success: true };
  }

  // Rejects a pending early attendance request.
  //
  // Ownership is validated by joining attendance -> students and checking
  // s.department_id = ?, ensuring coordinators can only reject records
  // belonging to students in their own department.
  //
  // Only transitions from 'pending' are allowed (AND a.early_status = 'pending').
  // This prevents double-reject and reject-after-approve.
  //
  // attendance table has NO academic_year_id; filtered via students join
  // (s.academic_year_id = ?).
  // coordinators table has NO academic_year_id — do not reference it here.
  static async rejectEarlyAttendance(
    attendance_id,
    academic_year_id,
    department_id
  ) {
    const [result] = await db.query(`
      UPDATE attendance a
      JOIN students s
        ON a.student_id = s.student_id
      SET a.early_status = 'rejected'
      WHERE a.attendance_id = ?
        AND s.academic_year_id = ?
        AND s.department_id = ?
        AND a.early_status = 'pending'
    `, [attendance_id, academic_year_id, department_id]);

    if (result.affectedRows === 0) {
      throw new Error("Early attendance request is already processed or not found");
    }

    return { success: true };
  }

  // Returns all pending early attendance requests for students in the
  // coordinator's department, scoped to an academic year.
  //
  // coordinators table has NO academic_year_id column, so academic year
  // can never be filtered through coordinators directly — the
  // coordinators table is not even joined here. Both required filters
  // (academic year AND department) are applied entirely through the
  // students join: s.academic_year_id scopes the academic year, and
  // s.department_id scopes the department. Since there is exactly one
  // coordinator per department, the caller passing that coordinator's
  // department_id is sufficient to scope results to that coordinator.
  static async getPendingEarlyAttendance(academic_year_id, department_id) {

    const [rows] = await db.query(`
      SELECT
        a.attendance_id,
        a.student_id,
        a.attendance_date,
        a.time_in,
        a.early_reason,
        a.early_status,
        a.early_attachment_url,
        a.early_attachment_public_id,
        a.early_attachment_name,
        s.start_time,
        s.end_time,
        u.f_name,
        u.l_name,
        u.photo

      FROM attendance a

      JOIN students s
        ON a.student_id = s.student_id

      JOIN users u
        ON s.user_id = u.user_id

      WHERE a.early_attendance = 1
        AND a.early_status = 'pending'
        AND s.academic_year_id = ?
        AND s.department_id = ?

      ORDER BY a.attendance_id DESC
    `, [academic_year_id, department_id]);

    return rows;
  }
}

module.exports = AttendanceModel;