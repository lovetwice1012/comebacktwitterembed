'use strict';

const fs = require('fs');
const { ApplicationCommandOptionType } = require('discord.js');
const { t, descriptionLocales, commandNameLocales } = require('../../../locales');
const { antiDirectoryTraversalAttack, conv_en_to_en_US } = require('../../../utils');
module.exports.execute = async function (interaction, client) {

    //saves/{userid}があるか確認する
    const userid = interaction.user.id;
    if (!fs.existsSync('./saves/' + userid)) return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
    const dirs = fs.readdirSync('./saves/' + userid);
    if (dirs.length === 0) return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
    //options: idが指定されているか確認する。設定されているならそのツイートを削除する。設定されていないなら一覧を表示する。
    if (interaction.options.getString('id') === null) {
        let content = '';
        dirs.forEach(element => {
            content += element + '\n';
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
        const id = interaction.options.getString('id');
        let filePath = userid + '/' + id;
        try{
            filePath = antiDirectoryTraversalAttack(filePath)
        }catch (e){
            return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
        }
        if (!fs.existsSync(filePath)) return await interaction.reply(t('userDonthaveSavedTweetLocales', interaction.locale));
        fs.rmdirSync(filePath, { recursive: true });
        await interaction.reply(t('deletedSavedTweetLocales', interaction.locale));
    }

};

module.exports.definition = {
        name: 'deletesavetweet',
        name_localizations: conv_en_to_en_US(commandNameLocales.delete),
        description: 'delete save tweet.',
        description_localizations: conv_en_to_en_US(descriptionLocales.settingsSaveTweetQuotaOverride),
        options: [
            {
                name: 'id',
                name_localizations: conv_en_to_en_US(commandNameLocales.id),
                description: 'string',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    };
