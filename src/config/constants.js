const config = require('../../config.json');

module.exports = {
    URL: config.URL,
    MUST_BE_MAIN_INSTANCE: true,
    SAVE_TWEET_DEFAULT_QUOTA: 100 * 1024 * 1024, // 100MB
    CONSOLE_LOG_INTERVAL: 10000, // 10 seconds
};
