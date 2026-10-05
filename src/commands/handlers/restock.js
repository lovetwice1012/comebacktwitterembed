'use strict';
module.exports = { definition: require('../../personalLinks/commands').definitions.restock,
    execute: interaction => require('../../personalLinks/ui').execute(interaction, 'restock') };
