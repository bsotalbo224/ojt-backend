let io = null;

const setIO = (instance) => {
  io = instance;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.IO has not been initialized");
  }
  return io;
};

module.exports = { setIO, getIO };