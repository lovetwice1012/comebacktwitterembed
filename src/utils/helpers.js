/**
 * Get string from localized object
 * @param {Object} object - Localized strings object
 * @param {string} locale - Locale code
 * @param {boolean} default_ja - Use Japanese as default instead of English
 * @returns {string} - Localized string
 */
function getStringFromObject(object, locale, default_ja = false) {
    if (object[locale] !== undefined) {
        return object[locale];
    }
    if (default_ja) {
        if (object["ja"] !== undefined) {
            return object["ja"];
        }
    }
    return object["en"];
}

/**
 * Check if user has any of the specified roles
 * @param {Object} user - Discord user object
 * @param {Array<string>} roleidlist - Array of role IDs
 * @returns {boolean}
 */
function ifUserHasRole(user, roleidlist) {
    if (user.roles.cache.some(role => roleidlist.includes(role.id))) {
        return true;
    } else {
        return false;
    }
}

/**
 * Convert boolean to localized enable/disable string
 * @param {boolean} bool - Boolean value
 * @param {string} locale - Locale code
 * @returns {string}
 */
function convertBoolToEnableDisable(bool, locale) {
    if (bool == true) {
        if (locale === 'ja') {
            return '有効';
        } else {
            return 'Enable';
        }
    } else {
        if (locale === 'ja') {
            return '無効';
        } else {
            return 'Disable';
        }
    }
}

/**
 * Send content array as message
 * @param {Object} message - Discord message object
 * @param {Array<string>} content - Content array
 * @returns {Promise}
 */
async function sendContentPromise(message, content) {
    return new Promise((resolve, reject) => {
        if (content.length == 0) return resolve();
        message.channel.send(content.join('\n')).then(msg => {
            resolve();
        }).catch(err => {
            reject(err);
        });
    });
}

/**
 * Check and remove disabled buttons from components
 * @param {Array} components - Message components
 * @param {string} guildId - Guild ID
 * @param {Object} setting - Settings object
 * @returns {Array} - Filtered components
 */
function checkComponentIncludesDisabledButtonAndIfFindDeleteIt(components, guildId, setting = null) {
    const settings = setting || require('./settings').getSettings();
    const invisibleSettings = settings.button_invisible[guildId] || {};

    if (Object.values(invisibleSettings).every(value => value === false)) {
        return components;
    }

    return components.reduce((acc, component) => {
        if (!component.components || component.components.length === 0) return acc;

        const filteredComponents = component.components.filter(subComponent => {
            const id = subComponent.data && subComponent.data.custom_id;
            return id ? !(id in invisibleSettings && invisibleSettings[id] === true) : true;
        });

        if (filteredComponents.length > 0) {
            component.components = filteredComponents;
            acc.push(component);
        }
        return acc;
    }, []);
}

/**
 * Convert en locale to en-US format for Discord
 * @param {Object} obj - Localization object
 * @returns {Object}
 */
function conv_en_to_en_US(obj) {
    if (obj.en !== undefined) {
        obj["en-US"] = obj.en;
        delete obj.en;
    }
    return obj;
}

module.exports = {
    getStringFromObject,
    ifUserHasRole,
    convertBoolToEnableDisable,
    sendContentPromise,
    checkComponentIncludesDisabledButtonAndIfFindDeleteIt,
    conv_en_to_en_US
};
