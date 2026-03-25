const mysql = require('mysql2');

const pool = mysql.createPool(process.env.DB_URL);

module.exports = pool.promise();