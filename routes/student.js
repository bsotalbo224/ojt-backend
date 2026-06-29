const express = require("express");
const router = express.Router();

const db = require("../config/db");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const studentController = require("../controllers/studentController");
const StudentModel = require("../models/StudentModel");


const validateCoordinatorCourse = async (user, courseId) => {
  if (user.role !== "coordinator") return;

  if (!courseId) {
    const err = new Error("Course is required");
    err.statusCode = 400;
    throw err;
  }

  const [coordinatorRows] = await db.query(
    "SELECT department_id FROM coordinators WHERE user_id = ?",
    [user.user_id]
  );

  if (!coordinatorRows.length) {
    const err = new Error("Coordinator profile not found");
    err.statusCode = 403;
    throw err;
  }

  const departmentId = coordinatorRows[0].department_id;

  const [courseRows] = await db.query(
    "SELECT course_id FROM courses WHERE course_id = ? AND department_id = ?",
    [courseId, departmentId]
  );

  if (!courseRows.length) {
    const err = new Error("Invalid course for coordinator department");
    err.statusCode = 403;
    throw err;
  }
};

const validateCoordinatorStudentAccess = async (user, studentId) => {
  if (user.role !== "coordinator") return;

  const [rows] = await db.query(
    `SELECT s.student_id
     FROM students s
     JOIN coordinators co
       ON co.department_id = s.department_id
     WHERE s.student_id = ?
     AND co.user_id = ?
     LIMIT 1`,
    [studentId, user.user_id]
  );

  if (!rows.length) {
    const err = new Error("Forbidden student access");
    err.statusCode = 403;
    throw err;
  }
};

router.get("/me", requireAuth, async (req, res) => {
  try {
    const studentId = req.user.student_id;
    const data = await StudentModel.getById(studentId);
    res.json(data);
  } catch (err) {
    console.error("STUDENT PROFILE ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/assignment", requireRole("student"), studentController.getMyAssignment);

router.get("/", requireAuth, async (req, res) => {
  try {

    const academic_year_id =
      req.headers["x-academic-year-id"] ||
      req.user.academic_year_id;

    let students;

    if (req.user.role === "admin") {
      students = await StudentModel.getAll(
        academic_year_id
      );
    }
    else if (req.user.role === "coordinator") {
      students = await StudentModel.getByCoordinator(
        req.user.user_id,
        academic_year_id
      );
    }
    else {
      return res.status(403).json({
        message: "Forbidden"
      });
    }

    res.json(students);

  } catch (err) {

    console.error("GET STUDENTS ERROR:", err);

    res.status(500).json({
      message: "Server error"
    });
  }
});

router.post("/", requireAuth, requireRole("admin", "coordinator"), async (req, res) => {
  try {
    const courseId = req.body.course_id || req.body.course;

    await validateCoordinatorCourse(req.user, courseId);

    const id = await StudentModel.create(req.body);
    res.status(201).json({ student_id: id });
  } catch (err) {
    console.error("CREATE STUDENT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Server error" });
  }
});

router.put("/:id", requireAuth, requireRole("admin", "coordinator"), async (req, res) => {
  try {
    const { id } = req.params;

    await validateCoordinatorStudentAccess(req.user, id);

    const courseId = req.body.course_id || req.body.course;

    if (courseId) {
      await validateCoordinatorCourse(req.user, courseId);
    }

    const result = await StudentModel.update(id, req.body);
    res.json(result);
  } catch (err) {
    console.error("UPDATE STUDENT ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Server error" });
  }
});

router.patch("/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const result = await StudentModel.setStatus(id, is_active);
    res.json(result);
  } catch (err) {
    console.error("STUDENT STATUS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});



module.exports = router;