const jwt = require("jsonwebtoken");

const verifyToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Missing auth token"
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Invalid token format"
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Default to the academic year embedded in the JWT.
    let academic_year_id = payload.academic_year_id || null;

    const selectedAcademicYear =
      req.headers["x-academic-year-id"];

    // Only admins and coordinators may override the academic year
    // via header. Students must always use the year from their JWT.
    if (
      selectedAcademicYear !== undefined &&
      (payload.role === "admin" || payload.role === "coordinator")
    ) {
      const parsedAcademicYear = Number(selectedAcademicYear);

      if (Number.isNaN(parsedAcademicYear)) {
        return res.status(400).json({
          success: false,
          message: "Invalid academic year id"
        });
      }

      academic_year_id = parsedAcademicYear;
    }

    req.user = {
      user_id: payload.user_id,
      role: payload.role,
      student_id: payload.student_id || null,
      coordinator_id: payload.coordinator_id || null,
      department_id: payload.department_id || null,
      academic_year_id
    };

    next();

  } catch (err) {

    if (process.env.NODE_ENV !== "production") {
      console.error("JWT Error:", err.message);
    }

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });

  }
};

const requireAuth = verifyToken;

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {

    if (!req.user?.role) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: no role assigned"
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: insufficient role"
      });
    }

    next();

  };
};

module.exports = {
  verifyToken,
  requireAuth,
  requireRole,
};