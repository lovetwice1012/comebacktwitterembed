'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyMediaDisplayToStep } = require('../../src/providers/_output_controls');

test('output controls: attachment mode keeps metadata embed and prunes media-only embeds', () => {
    const step = {
        embeds: [
            {
                title: 'Artwork title',
                url: 'https://example.com/artwork',
                color: 0x0096fa,
                image: { url: 'https://img.example/1.jpg' },
            },
            {
                url: 'https://example.com/artwork',
                color: 0x0096fa,
                image: { url: 'https://img.example/2.jpg' },
            },
        ],
    };

    applyMediaDisplayToStep(step, { media_display_mode: 'attachment' }, [
        'https://img.example/1.jpg',
        'https://img.example/2.jpg',
    ], 'Image');

    assert.equal(step.embeds.length, 1);
    assert.equal(step.embeds[0].title, 'Artwork title');
    assert.equal(step.embeds[0].image, undefined);
    assert.deepEqual(step.files, [
        'https://img.example/1.jpg',
        'https://img.example/2.jpg',
    ]);
});

test('output controls: link-only mode removes media-only embeds after moving image URLs to content', () => {
    const step = {
        embeds: [
            { url: 'https://example.com/post', color: 0x111111, image: { url: 'https://img.example/1.jpg' } },
            { url: 'https://example.com/post', color: 0x111111, image: { url: 'https://img.example/2.jpg' } },
        ],
    };

    applyMediaDisplayToStep(step, { media_display_mode: 'link_only' }, [
        'https://img.example/1.jpg',
        'https://img.example/2.jpg',
    ], 'Image');

    assert.equal(step.embeds, undefined);
    assert.match(step.content, /Image 1: https:\/\/img\.example\/1\.jpg/);
    assert.match(step.content, /Image 2: https:\/\/img\.example\/2\.jpg/);
});
