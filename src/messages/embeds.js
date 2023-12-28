client.on(Event.messageCreate,()=> {
    const embed = {
        title: json.user_name,
        url: json.tweetURL,
        description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
        color: 0x1DA1F2,
        author: {
            name: 'request by ' + message.author.username + '(id:' + message.author.id + ')',
        },
        footer: {
            text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
        },
        timestamp: new Date(json.date),
    };
})