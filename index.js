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
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: 'No special setup is required, just post the tweet link.',
            type: ActivityType.Watching
        }]
    });
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
                    const embed = {
                        title: json.user_name,
                        url: json.tweetURL,
                        description: json.text,
                        color: 0x1DA1F2,
                        author: {
                            name: json.user_screen_name,
                        }
                    };
                    //if the tweet has media
                    if (json.mediaURLs) {
                        if (json.mediaURLs.length == 1 && json.mediaURLs[0].includes('pbs.twimg.com')) {
                            embed.image = {
                                url: json.mediaURLs[0]
                            }
                        } else {
                            attachments = json.mediaURLs
                        }
                    }
                    if (attachments.length > 0) {
                        message.reply({
                            embeds: [
                                embed
                            ],
                            files: attachments,
                            allowedMentions: {
                                repliedUser: false
                            }
                        })
                    } else {
                        message.reply({
                            embeds: [
                                embed
                            ],
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