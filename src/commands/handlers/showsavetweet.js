'use strict';

const fs = require('fs');
const path = require('path');
const { ButtonBuilder, ButtonStyle, ComponentType, ApplicationCommandOptionType, PermissionsBitField, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { t, getStringFromObject, messageLocales, descriptionLocales, commandNameLocales } = require('../../locales');
const { settings, saveSettings, checkComponentIncludesDisabledButtonAndIfFindDeleteIt } = require('../../settings');
const { connection, queryDatabase, ensureUserExistsInDatabase } = require('../../db');
const {
    button_disabled_template,
    button_invisible_template,
    antiDirectoryTraversalAttack,
    ifUserHasRole,
    convertBoolToEnableDisable,
    conv_en_to_en_US,
} = require('../../utils');
const { sendTweetEmbed } = require('../../twitter');

module.exports.execute = async function (interaction, client) {

    //saves/{userid}があるか確認する
    const userid = interaction.user.id;
    if (!fs.existsSync('./saves/' + userid)) return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
    const dirs = fs.readdirSync('./saves/' + userid);
    if (dirs.length === 0) return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
    //options: idが指定されているか確認する。設定されているならそのツイートを表示する。設定されていないなら一覧を表示する。
    if (interaction.options.getString('id') === null) {
        let content = '';
        dirs.forEach(element => {
            //./saves/{userid}/{element}/data.jsonを読み込み、textの先頭10文字を取得する
            const data = fs.readFileSync('./saves/' + userid + '/' + element + '/data.json', 'utf-8');
            const json = JSON.parse(data);
            content += json.text.substring(0, 9) + '... Posted By ' + json.user_name + '(tweetid:' + element + ')\n';
        });
        await interaction.reply({
            embeds: [
                {
                    title: 'Saved tweets',
                    description: content,
                    color: 0x1DA1F2
                }
            ]
        });
    } else {
        await interaction.deferReply({ ephemeral: true });
        //./saves/{userid}/{id}があるか確認する
        let filePath = userid + '/' + interaction.options.getString('id')
        try{
            antiDirectoryTraversalAttack(filePath)
        }catch (e){
            return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
        }
        if (!fs.existsSync("./saves/" + filePath)) return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale));
        await interaction.editReply({ content: '処理中です...' });;
        await sendTweetEmbed(interaction, "https://twidata.sprink.cloud/data/" + filePath + "/data.json", false);
        //await sendTweetEmbed(interaction, "http://localhost:3088/data/" + filePath+ "/data.json", false);
        await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    }

};


module.exports.definition = {
        name: 'showsavetweet',
        name_localizations: conv_en_to_en_US(commandNameLocales.showSaveTweet),
        description: 'Shows save tweet.',
        description_localizations: conv_en_to_en_US(descriptionLocales.showSaveTweetcommand),
        options: [
            {
                name: 'id',
                name_localizations: conv_en_to_en_US(commandNameLocales.id),
                description: 'string',
                type: ApplicationCommandOptionType.String,
                required: false
            }
        ]
    };
