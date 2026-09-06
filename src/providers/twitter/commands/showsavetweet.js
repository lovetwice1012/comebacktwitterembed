'use strict';

const fs = require('fs');
const path = require('path');
const { ApplicationCommandOptionType } = require('discord.js');
const { t, descriptionLocales, commandNameLocales } = require('../../../locales');
const { antiDirectoryTraversalAttack, conv_en_to_en_US } = require('../../../utils');
const { sendEmbedPages } = require('../../../interactionResponse');
const { resolveSavedPath } = require('../../../savedRoot');
// twitter/index.js → commands/index.js → showsavetweet.js の循環参照を避けるため遅延ロード
function sendTweetEmbed(/** @type {any} */ message, /** @type {string} */ url, /** @type {any=} */ extra) {
    return require(/** @type {any} */ ('..')).sendTweetEmbed(message, url, extra);
}

module.exports.execute = async function (interaction, client) {

    //saves/{userid}があるか確認する
    const userid = interaction.user.id;
    let userPath;
    try { userPath = resolveSavedPath(userid, { mustExist: true }); }
    catch { return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale)); }
    const dirs = fs.readdirSync(userPath, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
    if (dirs.length === 0) return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale));
    //options: idが指定されているか確認する。設定されているならそのツイートを表示する。設定されていないなら一覧を表示する。
    if (interaction.options.getString('id') === null) {
        const lines = [];
        dirs.forEach(element => {
            // Read this user's data.json under the configured saved-media root.
            const data = fs.readFileSync(antiDirectoryTraversalAttack(path.join(userid, element, 'data.json')), 'utf-8');
            const json = JSON.parse(data);
            lines.push(json.text.substring(0, 9) + '... Posted By ' + json.user_name + '(tweetid:' + element + ')');
        });
        await sendEmbedPages(interaction, {
            title: 'Saved tweets',
            lines,
            emptyDescription: t('userDonthaveSavedTweetLocales', interaction.locale),
            color: 0x1DA1F2,
        });
    } else {
        // The slash-command option is one saved item, never another user path.
        const selectedId = interaction.options.getString('id');
        if (typeof selectedId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(selectedId)) return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale));
        const filePath = userid + '/' + selectedId;
        let savedPath;
        try{
            savedPath = antiDirectoryTraversalAttack(filePath)
        }catch (e){
            return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale));
        }
        if (!fs.statSync(savedPath).isDirectory()) return await interaction.editReply(t('userDonthaveSavedTweetLocales', interaction.locale));
        await interaction.editReply({ content: '処理中です...' });;
        await sendTweetEmbed(interaction, "https://twidata.sprink.cloud/data/" + filePath + "/data.json", { forceSendMode: 'channel' });
        //await sendTweetEmbed(interaction, "http://localhost:3088/data/" + filePath+ "/data.json", false);
        await interaction.editReply({ content: t('finishActionLocales', interaction.locale) });
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
