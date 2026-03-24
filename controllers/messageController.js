const MessageModel = require("../models/messageModel");
const { sendNotification } = require("../services/notificationServices");
const {io} = require("../server");
const db = require("../config/db");

/*
=================================
SEND MESSAGE
=================================
*/
exports.sendMessage = async (req, res) => {
  try {

    const senderId = req.user.user_id;

    const {
      receiver_id,
      message,
      message_type,
      related_log_id,
      related_narrative_id
    } = req.body;

    /* ── VALIDATION ── */
    if (!receiver_id || !message || !message.trim()) {
      return res.status(400).json({
        error: "Receiver and message required"
      });
    }

    if (receiver_id === senderId) {
      return res.status(400).json({
        error: "Cannot send message to yourself"
      });
    }

    /*
    =================================
    SAVE MESSAGE
    =================================
    */
    const insertResult = await MessageModel.sendMessage(
      senderId,
      receiver_id,
      message,
      {
        messageType: message_type,
        relatedLogId: related_log_id,
        relatedNarrativeId: related_narrative_id
      }
    );

    /*
    =================================
    GET FULL MESSAGE (WITH AVATAR)
    =================================
    */
    const [fullMessage] = await db.query(`
      SELECT
        m.*,
        COALESCE(u.f_name, 'System') AS f_name,
        COALESCE(u.l_name, '') AS l_name,
        u.photo
      FROM messages m
      LEFT JOIN users u
        ON m.sender_id = u.user_id
      WHERE m.id = ?
    `, [insertResult.insertId]);

    io.to(`user_${receiver_id}`).emit("receive_message", fullMessage[0]);

    /*
    =================================
    GET RECEIVER ROLE
    =================================
    */
    const [receiver] = await db.query(
      `SELECT role FROM users WHERE user_id = ?`,
      [receiver_id]
    );

    const receiverRole = receiver?.[0]?.role;

    /*
    =================================
    GENERATE LINK
    =================================
    */
    let link = `/messages?user=${senderId}`;

    if (receiverRole === "student") {
      link = `/student/messages?user=${senderId}`;
    }

    if (receiverRole === "coordinator") {
      link = `/coordinator/messages?user=${senderId}`;
    }

    if (receiverRole === "admin") {
      link = `/admin/messages?user=${senderId}`;
    }

    /*
    =================================
    GET SENDER NAME (FOR NOTIF)
    =================================
    */
    const [senderInfo] = await db.query(
      `SELECT f_name, l_name FROM users WHERE user_id = ?`,
      [senderId]
    );

    const senderName = senderInfo[0]
      ? `${senderInfo[0].f_name} ${senderInfo[0].l_name}`
      : "Someone";

    /*
    =================================
    SEND NOTIFICATION
    =================================
    */
    await sendNotification({
      user_id: receiver_id,
      type: "message",
      title: "New Message",
      message: `${senderName} sent you a message`,
      link
    });

    /*
    =================================
    RESPONSE
    =================================
    */
    res.json({
      success: true,
      message: "Message sent successfully",
      data: fullMessage[0]
    });

  } catch (error) {

    console.error("Send message error:", error);

    res.status(500).json({
      error: "Server error"
    });

  }
};


/*
=================================
GET SINGLE CONVERSATION
=================================
*/
exports.getConversation = async (req, res) => {
  try {

    const currentUser = req.user.user_id;
    const otherUser = req.params.userId;

    /* ── AUTO MARK AS READ ── */
    await MessageModel.markAsRead(otherUser, currentUser);

    const messages = await MessageModel.getConversation(
      currentUser,
      otherUser
    );

    res.json(messages);

  } catch (error) {

    console.error("Get conversation error:", error);

    res.status(500).json({
      success: false,
      error: "Server error"
    });

  }
};


/*
=================================
MARK MESSAGES AS READ
=================================
*/
exports.markAsRead = async (req, res) => {
  try {

    const receiver = req.user.user_id;
    const sender = req.params.userId;

    await MessageModel.markAsRead(sender, receiver);

    res.json({
      success: true
    });

  } catch (error) {

    console.error("Mark as read error:", error);

    res.status(500).json({
      success: false,
      error: "Server error"
    });

  }
};


/*
=================================
GET CONVERSATION LIST
=================================
*/
exports.getConversations = async (req, res) => {
  try {

    const userId = req.user.user_id;
    const roles = req.user.roles || [];

    const conversations = await MessageModel.getConversations(
      userId,
      roles
    );

    res.json({
      success: true,
      conversations
    });

  } catch (error) {

    console.error("Get conversations error:", error);

    res.status(500).json({
      success: false,
      error: "Server error"
    });

  }
};