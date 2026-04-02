/**
 * roleMiddleware.js
 * Single-role system (no more roles array)
 */

const requireRole = (role) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }


    if (req.user.role !== role && req.user.role !== "admin") {
      return res.status(403).json({
        message: "Forbidden (insufficient role)"
      });
    }

    next();
  };
};

const requireAnyRole = (roles = []) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Forbidden (insufficient role)"
      });
    }

    next();
  };
};

module.exports = {
  requireRole,
  requireAnyRole,
};