//discord.js v14
const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const config = require('./config.json');
const fetch = require('node-fetch');

const showAttachmentsAsEmbedsImagebuttonLocales = {
    ja: '画像を埋め込み画像として表示する',
    en: 'Show media in embeds image'
}

const showMediaAsAttachmentsButtonLocales = {
    ja: 'メディアを添付ファイルとして表示する',
    en: 'Show media as attachments'
}

const finishActionLocales = {
    ja: '操作を完了しました。',
    en: 'Finished action.'
}

const videoExtensions = [
    'mp4',
    'mov',
    'wmv',
    'avi',
    'avchd',
    'flv',
    'f4v',
    'swf',
    'mkv',
    'webm',
    'm4v',
    '3gp',
    '3g2',
    'mxf',
    'roq',
    'nsv',
    'gifv',
    'gif',
    'ts',
    'm2ts',
    'mts',
    'vob'
];

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
        },
        {
            name: 'invite',
            description: 'Invite me to your server!'
        },
        {
            name: 'support',
            description: 'Join support server!'
        }
    ]);
});

client.on(Events.MessageCreate, async (message) => {
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
                    let showMediaAsAttachmentsButton = null;
                    let messageObject = {
                        allowedMentions: {
                            repliedUser: false
                        }
                    };
                    if (json.text.length > 1500) {
                        json.text = json.text.slice(0, 300) + '...';
                    }
                    const embed = {
                        title: json.user_name,
                        url: json.tweetURL,
                        description: json.text + '\n\n[View on Twitter](' + json.tweetURL + ')\n\n:speech_balloon:' + json.replies + ' replies • :recycle:' + json.retweets + ' retweets • :heart:' + json.likes + ' likes',
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
                        if (json.mediaURLs.length > 4) {
                            if (json.mediaURLs.length > 10) {
                                json.mediaURLs = json.mediaURLs.slice(0, 10);
                            }
                            attachments = json.mediaURLs
                        } else {
                            json.mediaURLs.forEach(element => {
                                if (element.includes('video.twimg.com')) {
                                    attachments.push(element);
                                    return;
                                }
                                showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showMediaAsAttachmentsButtonLocales["en"]).setCustomId('showMediaAsAttachments');
                                embeds.push({
                                    url: json.tweetURL,
                                    image: {
                                        url: element
                                    }
                                })
                            });
                        }
                    }
                    if (attachments.length > 0) messageObject.files = attachments;
                    if (showMediaAsAttachmentsButton !== null) messageObject.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
                    messageObject.embeds = embeds;
                    message.reply(messageObject);
                })
                .catch(err => {
                    console.log(err);
                });
        });
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.ApplicationCommand) return;
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
    }else if (interaction.commandName === 'invite') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Invite',
                    description: 'Invite me to your server!',
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Invite link',
                            value: 'https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands'
                        }
                    ]
                }
            ]
        });
    }else if (interaction.commandName === 'support') {
        await interaction.reply({
            embeds: [
                {
                    title: 'Support',
                    description: 'Join support server!',
                    color: 0x1DA1F2,
                    fields: [
                        {
                            name: 'Support server link',
                            value: 'https://discord.gg/V5VUtS83SG'
                        }
                    ]
                }
            ]
        });
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.type === InteractionType.MessageComponent || interaction.type === InteractionType.ApplicationCommand) return;
    await interaction.deferReply({ ephemeral: true });
    switch (interaction.customId) {
        case 'showMediaAsAttachments':
            const showAttachmentsAsMediaButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showAttachmentsAsEmbedsImagebuttonLocales[interaction.locale] ?? showAttachmentsAsEmbedsImagebuttonLocales["en"]).setCustomId('showAttachmentsAsEmbedsImage');
            const messageObject = {};
            messageObject.components = [{ type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] }];
            messageObject.files = [];
            messageObject.embeds = [];
            interaction.message.embeds.forEach(element => {
                if (element.image) {
                    messageObject.files.push(element.image.url);
                }
            });
            messageObject.embeds.push(interaction.message.embeds[0]);
            if (messageObject.embeds[0].image) delete messageObject.embeds.image;
            await interaction.message.edit(messageObject);
            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            break;

        case 'showAttachmentsAsEmbedsImage':
            const showMediaAsAttachmentsButton = new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel(showMediaAsAttachmentsButtonLocales[interaction.locale] ?? showMediaAsAttachmentsButtonLocales["en"]).setCustomId('showMediaAsAttachments');
            const messageObject2 = {};
            if (interaction.message.attachments === undefined || interaction.message.attachments === null) return interaction.reply('There are no attachments to show.');
            const attachments = interaction.message.attachments.map(attachment => attachment.url);
            if (attachments.length > 4) return interaction.reply('You can\'t show more than 4 attachments as embeds image.');
            messageObject2.components = [{ type: ComponentType.ActionRow, components: [showMediaAsAttachmentsButton] }];
            messageObject2.embeds = [];
            messageObject2.embeds.push(interaction.message.embeds[0]);
            if (messageObject2.embeds[0].image) delete messageObject2.embeds.image;
            attachments.forEach(element => {
                const extension = element.split("?").pop().split('.').pop();
                if (videoExtensions.includes(extension)) {
                    messageObject2.files.push(element);
                    return;
                }
                messageObject2.embeds.push({
                    url: messageObject2.embeds[0].url,
                    image: {
                        url: element
                    }
                });
            });
            messageObject2.files = [];
            await interaction.message.edit(messageObject2);
            await interaction.editReply({ content: finishActionLocales[interaction.locale] ?? finishActionLocales["en"], ephemeral: true });
            setTimeout(() => {
                interaction.deleteReply();
            }, 3000);
            break;
    }
});

client.login(config.token);