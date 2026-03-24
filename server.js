require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

const { Server } = require("socket.io");

const db = require("./config/db");

const cron = require("node-cron");
const { archiveInactiveStudents } = require("./services/archiveServices");

const { requireAuth } = require("./middleware/authMiddleware");
const coordinatorScope = require("./middleware/coordinatorScope");

const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 5000;

/* =========================
   CREATE HTTP SERVER + SOCKET
========================= */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
  },
});

/* =========================
   ONLINE USERS STORE
========================= */
const onlineUsers = new Map();

/* =========================
   SOCKET CONNECTION
========================= */
io.on("connection", (socket) => {
  console.log(" User connected:", socket.id);

  // JOIN
  socket.on("join", (userId) => {
    socket.userId = userId;

    socket.join(`user_${userId}`);

    onlineUsers.set(userId, socket.id);

    io.emit("online_users", Array.from(onlineUsers.keys()));
  });

  // SEND MESSAGE (KEEP EXISTING)
  socket.on("send_message", (data) => {
    const { receiver_id } = data;

    io.to(`user_${receiver_id}`).emit("receive_message", data);
  });

  // TYPING INDICATOR
  socket.on("typing", ({ to }) => {
    io.to(`user_${to}`).emit("typing", socket.userId);
  });

  socket.on("stop_typing", ({ to }) => {
    io.to(`user_${to}`).emit("stop_typing", socket.userId);
  });

  // MESSAGE DELIVERED
  socket.on("message_delivered", ({ messageId, senderId }) => {
    io.to(`user_${senderId}`).emit("message_delivered", { messageId });
  });

  // MESSAGE SEEN
  socket.on("message_seen", ({ messageId, senderId }) => {
    io.to(`user_${senderId}`).emit("message_seen", { messageId });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    if (socket.userId) {
      onlineUsers.delete(socket.userId);
      io.emit("online_users", Array.from(onlineUsers.keys()));
    }
  });
});

/* =========================
   EXPORT IO (IMPORTANT)
========================= */
module.exports.io = io;

//////////////////////////////////////////////////////
// =========================
// ROUTE IMPORTS
// =========================
//////////////////////////////////////////////////////

// auth
const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");

// core modules
const adminRoutes = require("./routes/admin");
const coordinatorRoutes = require("./routes/coordinators");
const coordinatorStudentsRoutes = require("./routes/coordinatorStudents");

const companyRoutes = require("./routes/companies");
const studentRoutes = require("./routes/student");

const logsRoutes = require("./routes/logs");
const attendanceRoutes = require("./routes/attendance");
const narrativeRoutes = require("./routes/narrative");
const reviewRoutes = require("./routes/reviews");

const reportRoutes = require("./routes/report");
const progressRoutes = require("./routes/progress");

const notificationRoutes = require("./routes/notifications");
const uploadRoutes = require("./routes/upload");

const messageRoutes = require("./routes/messageRoutes");

// admin modules
const departmentsRoutes = require("./routes/departments");
const coursesRoutes = require("./routes/courses");
const adminReportsRoutes = require("./routes/adminReports");

// evaluation system
const evaluationTemplatesRoutes = require("./routes/evaluationTemplates");
const publicEvaluationRoutes = require("./routes/publicEvaluation");
const evaluationResponsesRoutes = require("./routes/evaluationResponses");

//////////////////////////////////////////////////////
// =========================
// GLOBAL MIDDLEWARE
// =========================
//////////////////////////////////////////////////////

const allowedOrigins = [
  "http://localhost:5173",
  process.env.CLIENT_URL,
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(morgan("dev"));
app.use(express.json());
app.use(cookieParser());

//////////////////////////////////////////////////////
// =========================
// PUBLIC ROUTES
// =========================
//////////////////////////////////////////////////////

app.use("/api/auth", authRoutes);

app.use("/uploads", express.static("uploads"));
app.use("/api/upload", uploadRoutes);

// Public evaluation (supervisor access)
app.use("/api/public-evaluation", publicEvaluationRoutes);

//////////////////////////////////////////////////////
// =========================
// AUTH REQUIRED
// =========================
//////////////////////////////////////////////////////

app.use(requireAuth);

// user info
app.use("/api/users", usersRoutes);

// messages
app.use("/api/messages", messageRoutes);

//////////////////////////////////////////////////////
// =========================
// CORE SYSTEM ROUTES
// =========================
//////////////////////////////////////////////////////

// admin
app.use("/api/admin", adminRoutes);

// coordinators
app.use("/api/coordinators", coordinatorRoutes);
app.use("/api/coordinators", coordinatorStudentsRoutes);

// department-scoped
app.use("/api/companies", coordinatorScope, companyRoutes);
app.use("/api/student", coordinatorScope, studentRoutes);

app.use("/api/logs", coordinatorScope, logsRoutes);
app.use("/api/attendance", coordinatorScope, attendanceRoutes);
app.use("/api/narratives", coordinatorScope, narrativeRoutes);
app.use("/api/reviews", coordinatorScope, reviewRoutes);

app.use("/api/report", coordinatorScope, reportRoutes);
app.use("/api/progress", coordinatorScope, progressRoutes);

// notifications
app.use("/api/notifications", notificationRoutes);

//////////////////////////////////////////////////////
// =========================
// ADMIN MODULES
// =========================
//////////////////////////////////////////////////////

app.use("/api/admin/departments", departmentsRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/admin-reports", adminReportsRoutes);

//////////////////////////////////////////////////////
// =========================
// EVALUATION SYSTEM
// =========================
//////////////////////////////////////////////////////

app.use("/api/evaluation-templates", evaluationTemplatesRoutes);
app.use("/api/evaluations", evaluationResponsesRoutes);

//////////////////////////////////////////////////////
// =========================
// 404 HANDLER
// =========================
//////////////////////////////////////////////////////

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

//////////////////////////////////////////////////////
// =========================
// GLOBAL ERROR HANDLER
// =========================
//////////////////////////////////////////////////////

app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

//////////////////////////////////////////////////////
// =========================
// CRON JOBS
// =========================
//////////////////////////////////////////////////////

cron.schedule("0 3 * * *", async () => {
  console.log("Running archive inactive students job...");
  await archiveInactiveStudents();
});

//////////////////////////////////////////////////////
// =========================
// START SERVER
// =========================
//////////////////////////////////////////////////////

db.getConnection()
  .then(() => {
    console.log("Database Connected Successfully");

    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Database Connection Failed:", err);
  });