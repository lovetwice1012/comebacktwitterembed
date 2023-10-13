//discord.js v14
const discord = require('discord.js');
const { Client, Events, GatewayIntentBits, Partials, ActivityType, InteractionType, ButtonBuilder, ButtonStyle, ComponentType, PermissionsBitField, ApplicationCommandOptionType  } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
const config = require('./config.json');
const fetch = require('node-fetch');
const fs = require('fs');

if(!fs.existsSync('./settings.json')) {
    fs.writeFileSync('./settings.json', JSON.stringify({
        "disable":{
            "user": [],
            "channel": [],
        },
        "bannedWords": {},
    }, null, 4));
}
const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

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
        },
        {
            name: 'settings',
            description: 'chenge Settings',
            options: [
                {
                    name: 'disable',
                    description: 'disable',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'user',
                            description: 'user',
                            type: ApplicationCommandOptionType.User,
                            required: false
                        },
                        {
                            name: 'channel',
                            description: 'channel',
                            type: ApplicationCommandOptionType.Channel,
                            required: false
                        }
                    ]
                },
                {
                    name: 'bannedwords',
                    description: 'bannedWords',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'word',
                            description: 'word',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                }
            ]
        }
    ]);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if ((message.content.includes('twitter.com') || message.content.includes('x.com')) && message.content.includes('status')) {
        const url = message.content.match(/(https?:\/\/[^\s]+)/g);
        if (url === null) return;
        if (settings.disable.user.includes(message.author.id)) return;
        if (settings.disable.channel.includes(message.channel.id)) return;

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
                    let detected_bannedword = false;
                    if (settings.bannedWords[message.guildId] !== undefined) {
                        settings.bannedWords[message.guildId].forEach(element => {
                            if (json.text.includes(element)) {
                                detected_bannedword = true;
                                return;
                            }
                        });

                        if (detected_bannedword) return message.reply('Your tweet contains a banned word.').then(msg => {
                            setTimeout(() => {
                                msg.delete();
                                    message.delete().catch(err => {
                                        message.channel.send('I don\'t have permission to delete messages.').then(msg2 => {
                                            setTimeout(() => {
                                                msg2.delete();
                                            }
                                            , 3000);
                                        });
                                    });
                            }, 3000);
                        });
                    }
                    
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
                        timestamp: new Date(json.date),
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
                    description: 'No special setup is required, just post the tweet link.\n\nThis bot can check the contents of messages you have sent.\nIt will only be used to check if the message you sent contains a twitter link, and will not be used for any other purpose.\nIt will not be used for any other purpose, nor will it record the messages you send.\nIf you do not trust us, you can secure your safety by removing your channel permissions from this bot.',
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
    }else if(interaction.commandName === 'settings'){
        if(!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)){
            if(interaction.options.getSubcommand() === 'disable'){
                if(interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null){
                    return await interaction.reply('You must specify a user or channel.');
                }

                if(interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null){
                    return await interaction.reply('You can\'t specify both a user and a channel.');
                }

                if(interaction.options.getUser('user') !== null){
                    const user = interaction.options.getUser('user');
                    if(settings.disable.user.includes(user.id)){
                        settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
                        await interaction.reply('Removed user from disable.user');
                    }else{
                        settings.disable.user.push(user.id);
                        await interaction.reply('Added user to disable.user');
                    }
                }else if(interaction.options.getChannel('channel') !== null){
                    const channel = interaction.options.getChannel('channel');
                    if(settings.disable.channel.includes(channel.id)){
                        settings.disable.channel.splice(settings.disable.channel.indexOf(channel.id), 1);
                        await interaction.reply('Removed channel from disable.channel');
                    }else{
                        settings.disable.channel.push(channel.id);
                        await interaction.reply('Added channel to disable.channel');
                    }
                }
            }else if(interaction.options.getSubcommand() === 'bannedwords'){
                if(interaction.options.getString('word') === null) return await interaction.reply('You must specify a word.');
                if(!interaction.guild.me.permissions.has(PermissionsBitField.Flags.ManageMessages)){
                    return await interaction.reply('I don\'t have permission to manage messages.');
                }
                const word = interaction.options.getString('word');
                if(settings.bannedWords[interaction.guildId] === undefined){
                    settings.bannedWords[interaction.guildId] = [];
                }
                if(settings.bannedWords[interaction.guildId].includes(word)){
                    settings.bannedWords[interaction.guildId].splice(settings.bannedWords[interaction.guildId].indexOf(word), 1);
                    await interaction.reply('Removed word from bannedWords');
                }else{
                    settings.bannedWords[interaction.guildId].push(word);
                    await interaction.reply('Added word to bannedWords');
                }
            }
        }else{
            if(interaction.options.getSubcommand() === 'disable'){
                if(interaction.options.getUser('user') === null && interaction.options.getChannel('channel') === null){
                    return await interaction.reply('You must specify a user or channel.');
                }

                if(interaction.options.getUser('user') !== null && interaction.options.getChannel('channel') !== null){
                    return await interaction.reply('You can\'t specify both a user and a channel.');
                }

                if(interaction.options.getUser('user') !== null){
                    const user = interaction.options.getUser('user');
                    if(user.id !== interaction.user.id) return await interaction.reply('You can\'t use this command for other users.');
                    if(settings.disable.user.includes(user.id)){
                        settings.disable.user.splice(settings.disable.user.indexOf(user.id), 1);
                        await interaction.reply('Removed you from disable.user');
                    }else{
                        settings.disable.user.push(user.id);
                        await interaction.reply('Added you to disable.user');
                    }
                }else if(interaction.options.getChannel('channel') !== null){
                    return await interaction.reply('You don\'t have permission to use this command.');
                }
            }else if(interaction.options.getSubcommand() === 'bannedwords'){
                await interaction.reply('You don\'t have permission to use this command.');
            }
        }
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 4));
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