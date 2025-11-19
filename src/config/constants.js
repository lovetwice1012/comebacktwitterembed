const fs = require('fs');
const path = require('path');

let config = {};
const configPath = path.join(__dirname, '../../config.json');

try {
    if (fs.existsSync(configPath)) {
        config = require('../../config.json');
    } else {
        console.warn('⚠️ config.json not found, using environment variables');
    }
} catch (error) {
    console.error('Error loading config.json:', error.message);
}

module.exports = {
    URL: config.URL || process.env.WEBHOOK_URL,
    MUST_BE_MAIN_INSTANCE: true,
    SAVE_TWEET_DEFAULT_QUOTA: 100 * 1024 * 1024, // 100MB
    CONSOLE_LOG_INTERVAL: 10000, // 10 seconds
};
