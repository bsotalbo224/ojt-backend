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
   PRESENCE TRACKING
========================= */
const onlineUsers = new Map();

const addOnlineUser = (userId, socketId) => {
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socketId);
};

const removeOnlineUser = (userId, socketId) => {
  const sockets = onlineUsers.get(userId);
  if (!sockets) return;

  sockets.delete(socketId);

  if (sockets.size === 0) {
    onlineUsers.delete(userId);
  }
};

const broadcastOnlineUsers = () => {
  io.emit("online_users", Array.from(onlineUsers.keys()));
};

/* =========================
   SOCKET CONNECTION
========================= */
io.on("connection", (socket) => {

  // Presence
  socket.on("join", (userId) => {
    if (!userId) return;

    socket.userId = userId;
    socket.join(`user_${userId}`);

    addOnlineUser(userId, socket.id);
    broadcastOnlineUsers();
  });

  // Conversation Rooms
  socket.on("join_conversation", (conversationId) => {
    if (!conversationId) return;
    socket.join(`conversation_${conversationId}`);
  });

  socket.on("leave_conversation", (conversationId) => {
    if (!conversationId) return;
    socket.leave(`conversation_${conversationId}`);
  });

  // Typing
  socket.on("typing", ({ conversationId } = {}) => {
    if (!conversationId || !socket.userId) return;
    socket.to(`conversation_${conversationId}`).emit("typing", {
      conversationId,
      userId: socket.userId,
    });
  });

  socket.on("stop_typing", ({ conversationId } = {}) => {
    if (!conversationId || !socket.userId) return;
    socket.to(`conversation_${conversationId}`).emit("stop_typing", {
      conversationId,
      userId: socket.userId,
    });
  });

  // Delivery & Read Receipts
  socket.on("message_delivered", ({ messageId, senderId } = {}) => {
    if (!messageId || !senderId) return;
    io.to(`user_${senderId}`).emit("message_delivered", { messageId });
  });

  socket.on("message_seen", ({ messageId, senderId } = {}) => {
    if (!messageId || !senderId) return;
    io.to(`user_${senderId}`).emit("message_seen", { messageId });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (socket.userId) {
      removeOnlineUser(socket.userId, socket.id);
      broadcastOnlineUsers();
    }
  });
});

module.exports.io = io;

//////////////////////////////////////////////////////
// =========================
// ROUTE IMPORTS
// =========================
//////////////////////////////////////////////////////

// auth
const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");

//upload
const uploadRoutes = require("./routes/upload");

// core modules
const adminRoutes = require("./routes/admin");
const coordinatorRoutes = require("./routes/coordinators");

const companyRoutes = require("./routes/companies");
const studentRoutes = require("./routes/student");
const requiredHoursRoutes = require("./routes/requiredHoursRoutes");

const logsRoutes = require("./routes/logs");
const attendanceRoutes = require("./routes/attendance");
const narrativeRoutes = require("./routes/narrative");
const reviewRoutes = require("./routes/reviews");

const reportRoutes = require("./routes/report");
const progressRoutes = require("./routes/progress");

const notificationRoutes = require("./routes/notifications");

const messageRoutes = require("./routes/messageRoutes");

// admin modules
const departmentsRoutes = require("./routes/departments");
const coursesRoutes = require("./routes/courses");
const adminReportsRoutes = require("./routes/adminReports");

// evaluation system
const evaluationTemplatesRoutes = require("./routes/evaluationTemplates");
const publicEvaluationRoutes = require("./routes/publicEvaluation");
const evaluationResponsesRoutes = require("./routes/evaluationResponses");

// academic year module
const academicYearsRoutes = require("./routes/academicYears");

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

// =========================
// HEALTH CHECK (KEEP RENDER AWAKE)
// =========================
app.get('/api/health', (req, res) => {
  res.send('OK');
});

//////////////////////////////////////////////////////
// =========================
// PUBLIC ROUTES
// =========================
//////////////////////////////////////////////////////

app.use("/api/auth", authRoutes);
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

app.use("/api/required-hours", requiredHoursRoutes);

// admin
app.use("/api/admin", adminRoutes);

// coordinators
app.use("/api/coordinators", coordinatorRoutes);

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

app.use("/api/academic-years", academicYearsRoutes);

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