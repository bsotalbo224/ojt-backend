/**
 * roleMiddleware.js
 * Supports multi-role users using req.user.roles
 */

const requireRole = (role) => {
  return (req, res, next) => {

    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const userRoles = req.user.roles || [];

    if (!userRoles.includes(role)) {
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

    const userRoles = req.user.roles || [];

    const allowed = roles.some(role => userRoles.includes(role));

    if (!allowed) {
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