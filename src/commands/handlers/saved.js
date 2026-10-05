'use strict';
module.exports = { definition: require('../../personalLinks/commands').definitions.saved,
    execute: interaction => require('../../personalLinks/ui').execute(interaction, 'saved') };
