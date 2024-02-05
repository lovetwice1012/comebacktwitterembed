const puppeteer = require('puppeteer');

async function tweet(TWITTER_BASE, LOGIN_ID, PASSWORD, TEXT) {
    
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  //await page.setDefaultNavigationTimeout(0); 
  await page.setViewport({ width: 1200, height: 1000 });

  const twitterBase = TWITTER_BASE + 'login/';
  const account = LOGIN_ID;
  const password = PASSWORD;

  await page.goto(twitterBase);
  await page.waitForTimeout(2000);

  // account入力
  await page.type('input[name="text"]', account);

  // デバッグ1
  await page.screenshot({ path: '①ログインID入力画面.png' });

  // 次へボタンクリック
  const nextButton = await page.$x('//div/span/span[text()="Next"]');
  await Promise.all([
    //page.waitForNavigation({ waitUntil: 'load'}),
    nextButton[0].click(),
  ]);
  await page.waitForTimeout(2000);

  await page.screenshot({ path: '③ログイン前の画面.png' });

  // パスワード入力
  await page.type('input[name="password"]', password);

  // ログインボタンクリック
  const loginButton = await page.$x('//div/span/span[text()="Log in"]');
  await Promise.all([
    //page.waitForNavigation({ waitUntil: 'load'}),
    loginButton[0].click(),
  ]);
  await page.waitForTimeout(5000);

  // デバッグ3
  await page.screenshot({ path: '③ログイン後の画面.png' });

  // 自動ツイート
  const tweetText = encodeURIComponent(TEXT);
  const targetURL = `${TWITTER_BASE}intent/tweet?text=${tweetText}`;
  console.log(targetURL);

  // 投稿画面へ遷移
  await page.goto(targetURL);
  await page.waitForTimeout(2000);

  // デバッグ4
  await page.screenshot({ path: '④ツイート画面.png' });

  // tweetボタンが読み込まれるまで待機（最大sleep2秒）
  await page.waitForSelector('div[data-testid="tweetButton"]', { timeout: 2000 });

  try {
    await page.click('div[data-testid="tweetButton"]');
    await page.waitForTimeout(10000);
    console.log('投稿完了！');

    // デバッグ5
    await page.screenshot({ path: '⑤ツイート完了画面.png' });
  } catch (error) {
    console.log('投稿エラー');

    // 次の投稿までの待機時間
    await page.waitForTimeout(10000);
  }

  await browser.close();
}

// Example usage:
const TWITTER_BASE = 'https://twitter.com/';
const LOGIN_ID = '';
const PASSWORD = '';
const TEXT = 'This is a test tweet.';

tweet(TWITTER_BASE, LOGIN_ID, PASSWORD, TEXT);
