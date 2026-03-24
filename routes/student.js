const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");
const studentController = require("../controllers/studentController");
const StudentModel = require("../models/StudentModel");


// ===================================================
// STUDENT: OWN PROFILE
// GET /api/student/me
// ===================================================
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

// ===================================================
// ADMIN / COORDINATOR: LIST STUDENTS
// GET /api/student
// ===================================================
router.get("/", requireAuth, async (req, res) => {
  try {
    let students;

    if (req.user.roles?.includes("admin")) {
      students = await StudentModel.getAll();
    } 
    else if (req.user.roles?.includes("coordinator")) {
      students = await StudentModel.getByCoordinator(req.user.user_id);
    } 
    else {
      return res.status(403).json({ message: "Forbidden" });
    }

    res.json(students);

  } catch (err) {
    console.error("GET STUDENTS ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================
// ADMIN: CREATE STUDENT
// POST /api/student
// ===================================================
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const id = await StudentModel.create(req.body);
    res.status(201).json({ student_id: id });
  } catch (err) {
    console.error("CREATE STUDENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ===================================================
// ADMIN: UPDATE STUDENT
// PUT /api/student/:id
// ===================================================
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await StudentModel.update(id, req.body);
    res.json(result);
  } catch (err) {
    console.error("UPDATE STUDENT ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// ===================================================
// ADMIN: TOGGLE STATUS
// PATCH /api/student/:id/status
// ===================================================
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
