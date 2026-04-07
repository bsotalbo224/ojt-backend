const mysql = require('mysql2');

const pool = mysql.createPool(process.env.DB_URL);

pool.getConnection().then(conn => {
  conn.query("SET time_zone = '+08:00'");
  conn.release();
});

module.exports = pool.promise();