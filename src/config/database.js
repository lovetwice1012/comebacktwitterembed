const mysql = require('mysql');

const connection = mysql.createConnection({
    host: process.env.DB_HOST || '192.168.100.22',
    user: process.env.DB_USER || 'comebacktwitterembed',
    password: process.env.DB_PASSWORD || 'bluebird',
    database: process.env.DB_NAME || 'ComebackTwitterEmbed'
});

module.exports = connection;
