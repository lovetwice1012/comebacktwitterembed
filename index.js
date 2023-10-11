//discord.js v14
const discord = require('discord.js');
const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const config = require('./config.json');
const fetch = require('node-fetch');


process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

client.on('ready', () => {
    console.log(`${client.user.tag} is ready!`);
    setInterval(() => {
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: client.guilds.cache.size + 'servers | No special setup is required, just post the tweet link.',
            type: ActivityType.Watching
        }]
    });
    }, 60000);
    client.application.commands.set([
        {
            name: 'help',
            description: 'Shows help message.'
        },
        {
            name: 'ping',
            description: 'Pong!'
        }
    ]);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if ((message.content.includes('twitter.com') || message.content.includes('x.com')) && message.content.includes('status')) {
        const url = message.content.match(/(https?:\/\/[^\s]+)/g);
        url.forEach(element => {
            //replace twitter.com or x.com with api.vxtwitter.com
            var newUrl = element.replace(/twitter.com|x.com/g, 'api.vxtwitter.com');
            if (newUrl.split("/").length > 6) {
                newUrl = newUrl.split("/").slice(0, 6).join("/");
            }
            //fetch the api
            fetch(newUrl)
                .then(res => res.json())
                .then(json => {
                    attachments = [];
                    let embeds = [];
                    if(json.text.length > 1500) {
                        json.text = json.text.slice(0, 300) + '...';
                    }
                    const embed = {
                        title: json.user_name,
                        url: json.tweetURL,
                        description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:'+json.replies+' replies • :recycle:'+json.retweets+' retweets • :heart:'+json.likes+' likes',
                        color: 0x1DA1F2,
                        author: {
                            name: json.user_screen_name,
                        },
                        footer: {
                            text: 'Posted by ' + json.user_name + ' (@' + json.user_screen_name + ')',
                            icon_url: 'https://abs.twimg.com/icons/apple-touch-icon-192x192.png'
                        },
                    };
                    embeds.push(embed);
                    //if the tweet has media
                    if (json.mediaURLs) {
                            if(json.mediaURLs.length > 4) {
                                if(json.mediaURLs.length > 10) {
                                    json.mediaURLs = json.mediaURLs.slice(0, 10);
                                }
                                attachments = json.mediaURLs
                            }else {
                                json.mediaURLs.forEach(element => {
                                    if(element.includes('video.twimg.com')) {
                                        attachments.push(element);
                                        return;
                                    }
                                    embeds.push({
                                        url: json.tweetURL,
                                        image: {
                                            url: element
                                        }
                                    })
                                });
                            }
                    }
                    if (attachments.length > 0) {
                        message.reply({
                            embeds: embeds,
                            files: attachments,
                            allowedMentions: {
                                repliedUser: false
                            }
                        })
                    } else {
                        message.reply({
                            embeds: embeds,
                            allowedMentions: {
                                repliedUser: false
                            }
                        })
                    }
                })
                .catch(err => {
                    console.log(err);
                });
        });
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === 'ping') {
        await interaction.reply('Pong!');
    } else if (interaction.commandName === 'help') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Help',
                    description: 'No special setup is required, just post the tweet link.',
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Commands',
                            value: '`/ping` - Pong!\n`/help` - Shows help message.'
                        }
                    ]
                }
            ]
        });
    }
});

client.login(config.token);