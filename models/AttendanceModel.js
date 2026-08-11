const db = require("../config/db");
const {
  sendNotification,
  NotificationTypes,
} = require("../services/notificationService");

function getPHTime() {
  return new Date().toLocaleTimeString("en-CA", {
    timeZone: "Asia/Manila",
    hour12: false
  });
}

// TIME-TO-MINUTES HELPER
function toMinutes(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
}

// EFFECTIVE TIME SQL FRAGMENT
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

// HOURS SUM SQL FRAGMENT
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

  // Standardized notification payload — every attendance notification goes through this.
  static async notify({
    user_id,
    sender_id = null,
    reference_id = null,
    title,
    message,
    type = NotificationTypes.ATTENDANCE,
    link,
    academic_year_id
  }) {
    await sendNotification({
      user_id,
      sender_id,
      reference_id,
      title,
      message,
      type,
      link,
      academic_year_id
    });
  }

  // ACTIVE ATTENDANCE
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

  // STUDENT ATTENDANCE
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

  // BY DEPARTMENT
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

  // CHECK IF LUNCH REQUIRED
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

    if (shiftHours < 0) {
      shiftHours += 24;
    }

    return shiftHours >= 5;
  }

  // TIME IN / START OT
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

    let early_attendance = false;
    let early_status = null;
    let early_reason_to_store = null;

    // EFFECTIVE TIME_IN TO PERSIST — defaults to actual clock-in time,
    // overridden to the schedule start time for minor early arrivals.
    let effectiveTimeIn = now;

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

        const isNightShift = scheduleMinutes >= 18 * 60;

        let isEarlyCandidate = false;

        if (isNightShift) {
          if (currentMinutes >= 0 && currentMinutes < 12 * 60) {
            isEarlyCandidate = false;
          } else {
            isEarlyCandidate = currentMinutes < scheduleMinutes;
          }
        } else {
          isEarlyCandidate = currentMinutes < scheduleMinutes;
        }

        if (isEarlyCandidate) {
          const earlyMinutes = scheduleMinutes - currentMinutes;

          const isMinorEarly =
            earlyMinutes >= 1 &&
            earlyMinutes <= 15;

          const isMajorEarly =
            earlyMinutes > 15;

          if (isMajorEarly) {
            if (!early_reason) {
              throw new Error("Reason is required for early attendance.");
            }
            if (!early_attachment_url) {
              throw new Error("Attachment is required for early attendance.");
            }
            early_attendance = true;
            early_status = "pending";
            early_reason_to_store = early_reason;
          } else if (isMinorEarly) {
            // Auto-clock-in at schedule start time, no modal, no reason required.
            effectiveTimeIn = student.start_time;
          }
        }
      }
    }

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
        effectiveTimeIn,
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

      if (early_attendance) {
        try {
          // student_user_id pulled from the same join, no extra query needed
          const [[studentInfo]] = await db.query(`
            SELECT
              u.f_name,
              u.l_name,
              u.user_id AS student_user_id,
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

            await this.notify({
              user_id: studentInfo.coordinator_user_id,
              sender_id: studentInfo.student_user_id ?? null,
              reference_id: result.insertId,
              title: "Early Attendance Request",
              message: `${fullName} submitted an early attendance request.\nTime In: ${timeInFormatted}\nScheduled Start: ${scheduledFormatted}`,
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

    if (active.time_in && !active.time_out) {
      throw new Error("Already timed in");
    }

    if (active.time_out && !active.ot_time_in) {
      await db.query(`
        UPDATE attendance
        SET ot_time_in = ?
        WHERE attendance_id = ?
      `, [now, active.attendance_id]);

      return;
    }

    if (active.ot_time_in && !active.ot_time_out) {
      throw new Error("OT already started");
    }

    throw new Error("Attendance already completed");
  }

  // START LUNCH
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

  // END LUNCH
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

  // TIME OUT / END OT
  static async timeOutByStudent(student_id, academic_year_id) {

    const now = getPHTime();

    const active = await this.getActiveAttendance(student_id, academic_year_id);

    if (!active) {
      throw new Error("No active attendance");
    }

    if (active.time_in && !active.time_out) {
      await db.query(`
        UPDATE attendance
        SET time_out = ?
        WHERE attendance_id = ?
      `, [now, active.attendance_id]);

      await this.checkCompletionAndNotify(student_id, academic_year_id);
      return;
    }

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

  // HOURS COMPUTATION
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

  // COMPLETION CHECK
  static async checkCompletionAndNotify(student_id, academic_year_id) {

    const [[row]] = await db.query(`
      SELECT
        s.user_id,
        s.ojt_hours_required AS required_hours,

        IFNULL(
          SUM(${HOURS_SUM_EXPR}),
          0
        ) AS completed_hours,

        MAX(a.attendance_id) AS latest_attendance_id

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

    await this.notify({
      user_id: row.user_id,
      sender_id: null,
      reference_id: row.latest_attendance_id,
      title: "OJT Completed",
      message: "Congratulations! You have completed your required OJT hours.",
      link: "/student/progress",
      academic_year_id
    });
  }

  // TODAY (fallback query scoped to CURDATE() only)
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
        AND a.attendance_date = CURDATE()

      ORDER BY a.attendance_id DESC
      LIMIT 1
    `, [student_id, academic_year_id]);

    return rows[0] || null;
  }

  // HISTORY (PAGINATED)
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

  // HISTORY (FULL, UNPAGINATED — FOR EXPORT)
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

  // UPDATE LOCATION STATUS
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

  // COORDINATOR: STUDENT RECORDS
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

  // Notify the student once a coordinator approves/rejects their early attendance request.
  // student_user_id / coordinator_user_id are passed in — no query performed here.
  static async notifyEarlyAttendanceDecision(
    attendance_id,
    academic_year_id,
    student_user_id,
    coordinator_user_id,
    decision
  ) {
    if (!student_user_id) return;

    try {
      const approved = decision === "approved";

      await this.notify({
        user_id: student_user_id,
        sender_id: coordinator_user_id ?? null,
        reference_id: attendance_id,
        title: approved ? "Early Attendance Approved" : "Early Attendance Rejected",
        message: approved
          ? "Your early attendance request has been approved."
          : "Your early attendance request has been rejected.",
        link: "/student/attendance",
        academic_year_id
      });
    } catch (error) {
      console.error("Early attendance decision notification failed:", error);
    }
  }

  // EARLY ATTENDANCE: APPROVE
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

    // Single lookup covers both the student (notification target) and the coordinator (sender_id)
    const [[info]] = await db.query(`
      SELECT
        u.user_id AS student_user_id,
        cu.user_id AS coordinator_user_id
      FROM attendance a
      JOIN students s
        ON a.student_id = s.student_id
      JOIN users u
        ON s.user_id = u.user_id
      LEFT JOIN coordinators c
        ON s.department_id = c.department_id
      LEFT JOIN users cu
        ON c.user_id = cu.user_id
      WHERE a.attendance_id = ?
      LIMIT 1
    `, [attendance_id]);

    await this.notifyEarlyAttendanceDecision(
      attendance_id,
      academic_year_id,
      info?.student_user_id,
      info?.coordinator_user_id,
      "approved"
    );

    return { success: true };
  }

  // EARLY ATTENDANCE: REJECT
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

    // Single lookup covers both the student (notification target) and the coordinator (sender_id)
    const [[info]] = await db.query(`
      SELECT
        u.user_id AS student_user_id,
        cu.user_id AS coordinator_user_id
      FROM attendance a
      JOIN students s
        ON a.student_id = s.student_id
      JOIN users u
        ON s.user_id = u.user_id
      LEFT JOIN coordinators c
        ON s.department_id = c.department_id
      LEFT JOIN users cu
        ON c.user_id = cu.user_id
      WHERE a.attendance_id = ?
      LIMIT 1
    `, [attendance_id]);

    await this.notifyEarlyAttendanceDecision(
      attendance_id,
      academic_year_id,
      info?.student_user_id,
      info?.coordinator_user_id,
      "rejected"
    );

    return { success: true };
  }

  // EARLY ATTENDANCE: PENDING LIST
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