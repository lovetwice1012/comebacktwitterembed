const mysql = require('mysql2/promise');

// MySQL接続プールの作成
const pool = mysql.createPool({
    host: '192.168.100.22',
    user: 'comebacktwitterembed',
    password: 'bluebird',
    database: 'ComebackTwitterEmbed',
    connectionLimit: 10,        // 最大接続数
    queueLimit: 0,              // キュー制限なし
    waitForConnections: true,   // 接続待機を有効化
    enableKeepAlive: true,      // キープアライブ有効化
    keepAliveInitialDelay: 0
});

// 接続テスト
pool.getConnection()
    .then(connection => {
        console.log('MySQL接続プールが正常に初期化されました');
        connection.release();
    })
    .catch(err => {
        console.error('MySQL接続プールの初期化に失敗しました:', err);
    });

// 定期的な接続チェック（1時間ごと）
setInterval(async () => {
    try {
        const connection = await pool.getConnection();
        await connection.query('SELECT 1');
        connection.release();
    } catch (err) {
        console.error('MySQL接続チェックエラー:', err);
    }
}, 3600000);

module.exports = pool;
