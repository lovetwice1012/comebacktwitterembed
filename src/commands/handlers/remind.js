'use strict';
module.exports = { definition: require('../../personalLinks/commands').definitions.remind,
    execute: interaction => require('../../personalLinks/ui').execute(interaction, 'reminder') };
