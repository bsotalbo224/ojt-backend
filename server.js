require("dotenv").config();

// Node.js modules
const http = require("http");

// Third-party packages
const cookieParser = require("cookie-parser");
const cors = require("cors");
const cron = require("node-cron");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const { Server } = require("socket.io");

// Configuration
const db = require("./config/db");

// Services
const { archiveInactiveStudents } = require("./services/archiveServices");
const { setSocket } = require("./services/notificationService");

// Middleware
const { requireAuth } = require("./middleware/authMiddleware");
const coordinatorScope = require("./middleware/coordinatorScope");

// Routes
const academicYearsRoutes = require("./routes/academicYears");
const adminReportsRoutes = require("./routes/adminReports");
const adminRoutes = require("./routes/admin");
const attendanceRoutes = require("./routes/attendance");
const authRoutes = require("./routes/auth");
const companyRoutes = require("./routes/companies");
const coordinatorRoutes = require("./routes/coordinators");
const coursesRoutes = require("./routes/courses");
const departmentsRoutes = require("./routes/departments");
const evaluationResponsesRoutes = require("./routes/evaluationResponses");
const evaluationTemplatesRoutes = require("./routes/evaluationTemplates");
const logsRoutes = require("./routes/logs");
const messageRoutes = require("./routes/messageRoutes");
const narrativeRoutes = require("./routes/narrative");
const notificationRoutes = require("./routes/notifications");
const progressRoutes = require("./routes/progress");
const publicEvaluationRoutes = require("./routes/publicEvaluation");
const reportRoutes = require("./routes/report");
const requiredHoursRoutes = require("./routes/requiredHoursRoutes");
const reviewRoutes = require("./routes/reviews");
const studentRoutes = require("./routes/student");
const uploadRoutes = require("./routes/upload");
const usersRoutes = require("./routes/users");

// Constants
const PORT = process.env.PORT || 5000;
const HEALTH_CHECK_RESPONSE = "OK";

const USER_ROOM_PREFIX = "user_";
const CONVERSATION_ROOM_PREFIX = "conversation_";

const userRoom = (id) => `${USER_ROOM_PREFIX}${id}`;
const conversationRoom = (id) => `${CONVERSATION_ROOM_PREFIX}${id}`;

const SOCKET_EVENTS = Object.freeze({
  JOIN: "join",
  JOIN_CONVERSATION: "join_conversation",
  LEAVE_CONVERSATION: "leave_conversation",
  TYPING: "typing",
  STOP_TYPING: "stop_typing",
  MESSAGE_DELIVERED: "message_delivered",
  MESSAGE_SEEN: "message_seen",
  ONLINE_USERS: "online_users",
});

const allowedOrigins = Object.freeze(["http://localhost:5173", process.env.CLIENT_URL]);

// Server creation
const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    credentials: true,
  },
});

setSocket(io);

// Socket.IO
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
  io.emit(SOCKET_EVENTS.ONLINE_USERS, Array.from(onlineUsers.keys()));
};

io.on("connection", (socket) => {
  // Presence
  socket.on(SOCKET_EVENTS.JOIN, (userId) => {
    if (!userId) return;

    socket.userId = userId;
    socket.join(userRoom(userId));

    // TEMP DIAGNOSTIC — remove once conversation_updated delivery is confirmed fixed.
    console.log("[USER ROOM JOIN]", {
      userId,
      room: userRoom(userId),
    });

    addOnlineUser(userId, socket.id);
    broadcastOnlineUsers();
  });

  // Conversation rooms
  socket.on(SOCKET_EVENTS.JOIN_CONVERSATION, (conversationId) => {
    if (!conversationId) return;
    socket.join(conversationRoom(conversationId));
  });

  socket.on(SOCKET_EVENTS.LEAVE_CONVERSATION, (conversationId) => {
    if (!conversationId) return;
    socket.leave(conversationRoom(conversationId));
  });

  // Typing indicators
  socket.on(SOCKET_EVENTS.TYPING, ({ conversationId } = {}) => {
    if (!conversationId || !socket.userId) return;
    socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.TYPING, {
      conversationId,
      userId: socket.userId,
    });
  });

  socket.on(SOCKET_EVENTS.STOP_TYPING, ({ conversationId } = {}) => {
    if (!conversationId || !socket.userId) return;
    socket.to(conversationRoom(conversationId)).emit(SOCKET_EVENTS.STOP_TYPING, {
      conversationId,
      userId: socket.userId,
    });
  });

  // Delivery and read receipts
  socket.on(SOCKET_EVENTS.MESSAGE_DELIVERED, ({ messageId, senderId } = {}) => {
    if (!messageId || !senderId) return;
    io.to(userRoom(senderId)).emit(SOCKET_EVENTS.MESSAGE_DELIVERED, { messageId });
  });

  socket.on(SOCKET_EVENTS.MESSAGE_SEEN, ({ messageId, senderId } = {}) => {
    if (!messageId || !senderId) return;
    io.to(userRoom(senderId)).emit(SOCKET_EVENTS.MESSAGE_SEEN, { messageId });
  });

  socket.on("disconnect", () => {
    if (!socket.userId) return;

    removeOnlineUser(socket.userId, socket.id);
    broadcastOnlineUsers();
  });
});

module.exports = { io };

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
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

// Health check (keeps Render awake)
app.get("/api/health", (req, res) => {
  res.send(HEALTH_CHECK_RESPONSE);
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/public-evaluation", publicEvaluationRoutes);

// Auth required beyond this point
app.use(requireAuth);

app.use("/api/users", usersRoutes);
app.use("/api/messages", messageRoutes);

app.use("/api/required-hours", requiredHoursRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/coordinators", coordinatorRoutes);

// Department-scoped routes
app.use("/api/companies", coordinatorScope, companyRoutes);
app.use("/api/student", coordinatorScope, studentRoutes);
app.use("/api/logs", coordinatorScope, logsRoutes);
app.use("/api/attendance", coordinatorScope, attendanceRoutes);
app.use("/api/narratives", coordinatorScope, narrativeRoutes);
app.use("/api/reviews", coordinatorScope, reviewRoutes);
app.use("/api/report", coordinatorScope, reportRoutes);
app.use("/api/progress", coordinatorScope, progressRoutes);

app.use("/api/notifications", notificationRoutes);

// Admin modules
app.use("/api/academic-years", academicYearsRoutes);
app.use("/api/admin/departments", departmentsRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api/admin-reports", adminReportsRoutes);

// Evaluation system
app.use("/api/evaluation-templates", evaluationTemplatesRoutes);
app.use("/api/evaluations", evaluationResponsesRoutes);

// Error handling
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack || err);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// Cron jobs
cron.schedule("0 3 * * *", async () => {
  console.log("Running archive inactive students job...");
  await archiveInactiveStudents();
});

// Startup
db.getConnection()
  .then(() => {
    console.log("Database Connected Successfully");

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database Connection Failed:", err);
  });