const { login, close, tweet, getPrivateTweet } = require('./twitter/twitter');

const TWITTER_BASE = '';
const LOGIN_ID = '';
const PASSWORD = '';
const TEXT = '';
PRIVATEURL = '';

(async () => {
    const { page,browser } = await login(TWITTER_BASE, LOGIN_ID, PASSWORD);
    //await tweet(page, browser, TWITTER_BASE, TEXT);
    await getPrivateTweet(page, browser, TWITTER_BASE, PRIVATEURL);
    await close(page, browser);
    })();