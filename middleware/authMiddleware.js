/**
 * authMiddleware.js
 * - Verifies JWT from Bearer token
 * - Sets req.user = decoded payload
 * - Supports multiple roles
 */

const jwt = require("jsonwebtoken");

// Verify JWT token
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

    req.user = {
      user_id: payload.user_id,
      role: Array.isArray(payload.roles) ? payload.roles[0] : null,

      roles: Array.isArray(payload.roles) ? payload.roles : [],

      student_id: payload.student_id || null,
      coordinator_id: payload.coordinator_id || null,
      department_id: payload.department_id || null
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

// Alias for cleaner routes
const requireAuth = verifyToken;


/*
=================================
 ROLE BASED ACCESS CONTROL
=================================
*/
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {

    if (!req.user?.roles || req.user.roles.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: no roles assigned"
      });
    }

    const hasRole = req.user.roles.some(role =>
      allowedRoles.includes(role)
    );

    if (!hasRole) {
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