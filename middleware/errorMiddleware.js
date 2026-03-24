/**
 * errorMiddleware.js
 * - Centralized error handler for express
 * - Use at the end of your middleware chain: app.use(errorHandler)
 *
 * Example:
 *   app.use("/api", routes);
 *   app.use(errorHandler);
 */

const errorHandler = (err, req, res, next) => {
  console.error(err);

  // Default values
  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  // In dev, optionally include stack
  const response = {
    success: false,
    message,
  };

  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
