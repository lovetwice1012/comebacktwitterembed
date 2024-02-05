const puppeteer = require('puppeteer');

async function login(TWITTER_BASE, LOGIN_ID, PASSWORD) {

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
        nextButton[0].click(),
    ]);
    await page.waitForTimeout(2000);

    await page.screenshot({ path: '③ログイン前の画面.png' });

    // パスワード入力
    await page.type('input[name="password"]', password);

    // ログインボタンクリック
    const loginButton = await page.$x('//div/span/span[text()="Log in"]');
    await Promise.all([
        loginButton[0].click(),
    ]);
    await page.waitForTimeout(5000);

    // デバッグ3
    await page.screenshot({ path: '③ログイン後の画面.png' });

    return { page, browser };

}

async function close(page, browser) {
    await page.close();
    await browser.close();
}

async function tweet(page, browser, TWITTER_BASE, TEXT) {

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

}

async function getPrivateTweet(page, browser, TWITTER_BASE, URL) {

    // 投稿画面へ遷移
    await page.goto(URL);
    await page.waitForTimeout(2000);

    // デバッグ4
    await page.screenshot({ path: 'ツイート画面.png' });

    await page.waitForTimeout(2000);

    //表示名を取得(xpath)
    const displayName = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[2]/div[2]/div/div/div[1]/div/div/div[1]/div/a/div/div[1]/span/span');
    const displayNameText = await page.evaluate(el => el.textContent, displayName[0]);
    console.log(displayNameText);

    //ユーザーIDを取得(xpath)
    const userID = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[2]/div[2]/div/div/div[1]/div/div/div[2]/div/div/a/div/span');
    const userIDText = await page.evaluate(el => el.textContent, userID[0]);
    console.log(userIDText);

    //ツイート本文を取得(xpath)
    const tweetText = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[1]/div/div/span');
    const tweetTextText = await page.evaluate(el => el.textContent, tweetText[0]);
    console.log(tweetTextText);

    //日付を取得(xpath)
    const date = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[4]/div/div[1]/div/div[1]/a/time');
    const dateText = await page.evaluate(el => el.textContent, date[0]);
    console.log(dateText);//10:10 PM · Jan 30, 2024
    //convert format: mm/dd/yyyy hh:mm
    const dateTextArray = dateText.split(" ");
    const time = dateTextArray[0].split(":");
    let hour = time[0];
    let minute = time[1];
    const ampm = dateTextArray[1];
    const month = dateTextArray[3];
    const day = dateTextArray[4].replace(",", "");
    const year = dateTextArray[5];
    if(ampm === "PM") {
        hour = parseInt(hour) + 12;
    }
    const dateTextConverted = month + "/" + day + "/" + year + " " + hour + ":" + minute;
    console.log(dateTextConverted);
    const unixtimestamp = Date.parse(dateTextConverted);
    console.log(unixtimestamp);

    //いいね数を取得(xpath)
    const likeCount = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[5]/div/div/div[3]/div/div/div[2]/span/span');
    let likeCountText = "";
    if(likeCount.length !== 0) {
        likeCountText = await page.evaluate(el => el.textContent, likeCount[0]);
    } else {
        likeCountText = "0";
    }
    if(likeCountText === "") {
        likeCountText = "0";
    }
    console.log(likeCountText);

    //リツイート数を取得(xpath)
    const retweetCount = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[5]/div/div/div[2]/div/div/div[2]/span/span');
    let retweetCountText = "";
    if(retweetCount.length !== 0) {
    retweetCountText = await page.evaluate(el => el.textContent, retweetCount[0]);
    } else {
        retweetCountText = "0";
    }
    if(retweetCountText === "") {
        retweetCountText = "0";
    }
    console.log(retweetCountText);

    //返信数を取得(xpath)
    const replyCount = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[3]/div[6]/div/div/div[3]/div/div/div[2]/span/span');
    let replyCountText = "";
    if(replyCount.length !== 0) {
        replyCountText = await page.evaluate(el => el.textContent, replyCount[0]);
    } else {
        replyCountText = "0";
    }
    if(replyCountText === "") {
        replyCountText = "0";
    }
    console.log(replyCountText);

    //投稿ユーザーのプロフィール画像を取得(xpath)
    const profileImage = await page.$x('/html/body/div[1]/div/div/div[2]/main/div/div/div/div/div/section/div/div/div[1]/div/div/article/div/div/div[2]/div[1]/div/div/div/div[2]/div/div[2]/div/a/div[3]/div/div[2]/div/img');
    const profileImageSrc = await page.evaluate(el => el.getAttribute('src'), profileImage[0]);
    console.log(profileImageSrc);
}

module.exports = {
    login,
    close,
    tweet,
    getPrivateTweet
}
