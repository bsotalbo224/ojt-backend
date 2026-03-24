const db = require("../config/db");

module.exports = function coordinatorScope(req, res, next) {
  try {
    // No user yet → skip
    if (!req.user) {
      return next();
    }

    // Only apply to coordinator role
    if (req.user.role === "coordinator") {
      req.department_id = req.user.department_id;
      req.coordinator_id = req.user.coordinator_id;
    }

    next();
  } catch (err) {
    console.error("Coordinator scope error:", err);
    next(err);
  }
};
