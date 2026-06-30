'use strict';

module.exports = {
    gui: {
        provider: 'Provider',
        setting: 'Setting',
        value: 'Value',
        currentValue: 'Current value',
        empty: '(empty)',
        selectSettingToEdit: 'Select a setting to edit.',
        editing: 'Editing: {label}',
        title: 'GUI Settings - {provider}',
        refresh: 'Refresh',
        close: 'Close',
        closed: 'GUI settings closed.',
        enable: 'Enable',
        disable: 'Disable',
        enabled: 'Enabled',
        disabled: 'Disabled',
        none: 'None',
        users: 'Users',
        channels: 'Channels',
        roles: 'Roles',
        userTargets: 'user',
        channelTargets: 'channel',
        roleTargets: 'role',
        toggleUsers: 'Toggle users',
        toggleChannels: 'Toggle channels',
        toggleRoles: 'Toggle roles',
        hiddenButtons: 'Hidden buttons',
        showAll: 'Show all',
        hideAll: 'Hide all',
        updatedHiddenButtons: 'Updated hidden buttons.',
        updatedTargets: 'Updated {targetType} targets.',
        addedTarget: 'Added {target}.',
        removedTarget: 'Removed {target}.',
        bannedWordEmpty: 'Banned word was empty.',
        addedBannedWord: 'Added banned word: {word}',
        removedBannedWord: 'Removed banned word: {word}',
        removedBannedWordsCount: 'Removed {count} banned word(s).',
        removeBannedWords: 'Remove banned words',
        addRemoveWord: 'Add / remove word',
        bannedWordModalTitle: 'Add or remove banned word',
        word: 'Word',
        bannedWordPlaceholder: 'Existing words are removed; new words are added.',
        unknownGuiAction: 'Unknown GUI action.',
        unknownForm: 'Unknown form.',
        noPermission: 'You do not have permission to use this command.',
        manageMessagesRequired: 'Manage Messages permission is required for banned words.',
        moreItems: '...and {count} more',
        commandName: 'guisetting',
        commandDescription: 'Change settings with a GUI',
        providerOptionDescription: 'Provider to open first',
        settings: {
            overview: {
                label: 'Overview',
                description: 'Current GUI-editable settings.',
            },
            disable: {
                label: 'Disable extraction',
                description: 'Toggle disabled users, channels, and roles.',
            },
            defaultLanguage: {
                label: 'Default language',
                description: 'Language used by translate actions.',
            },
            editOriginalIfTranslate: {
                label: 'Edit original after translate',
                description: 'Edit the original response when translating.',
            },
            extract_bot_message: {
                label: 'Extract bot messages',
                description: 'Allow links posted by bots to be expanded.',
            },
            button_invisible: {
                label: 'Hide buttons',
                description: 'Choose which response buttons should be hidden.',
            },
            button_disabled: {
                label: 'Disable buttons for targets',
                description: 'Toggle users, channels, and roles that cannot use buttons.',
            },
            bannedWords: {
                label: 'Banned words',
                description: 'Add or remove words blocked from expansion.',
            },
            sendMediaAsAttachmentsAsDefault: {
                label: 'Media as attachments by default',
                description: 'Send media as attachments by default.',
            },
            deletemessageifonlypostedtweetlink: {
                label: 'Delete link-only message',
                description: 'Delete the source message when it only contains a tweet link.',
            },
            deletemessageifonlypostedtweetlink_secoundaryextractmode: {
                label: 'Delete link-only in secondary mode',
                description: 'Also delete link-only messages in secondary extract mode.',
            },
            alwaysreplyifpostedtweetlink: {
                label: 'Always reply to tweet links',
                description: 'Always reply when a tweet link is posted.',
            },
            anonymous_expand: {
                label: 'Anonymous expand',
                description: 'Hide requester and author information in expanded tweets.',
            },
            quote_repost_do_not_extract: {
                label: 'Do not extract quote reposts',
                description: 'Skip expansion for quoted repost content.',
            },
            quote_repost_max_depth: {
                label: 'Quote repost max depth',
                description: 'Maximum quote repost expansion depth.',
            },
            legacy_mode: {
                label: 'Legacy mode',
                description: 'Use legacy expansion behavior.',
            },
            passive_mode: {
                label: 'Passive mode',
                description: 'Send only media-view buttons.',
            },
            secondary_extract_mode: {
                label: 'Secondary extract mode',
                description: 'Only send when selected secondary targets match.',
            },
            secondary_extract_mode_multiple_images: {
                label: 'Secondary target: multiple images',
                description: 'Match posts with multiple images in secondary mode.',
            },
            secondary_extract_mode_video: {
                label: 'Secondary target: videos',
                description: 'Match posts with videos in secondary mode.',
            },
            pixiv_images_per_step: {
                label: 'Images per step',
                description: 'Number of Pixiv images sent per response step.',
            },
        },
        buttons: {
            showMediaAsAttachments: 'Media as attachments',
            showAttachmentsAsEmbedsImage: 'Media in embeds',
            translate: 'Translate',
            delete: 'Delete',
            savetweet: 'Save tweet',
        },
        choices: {
            defaultLanguage: {
                en: 'English',
                ja: 'Japanese',
            },
            quote_repost_max_depth: {
                0: 'Unlimited',
            },
        },
    },
};
