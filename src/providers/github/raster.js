'use strict';

const zlib = require('zlib');
const jpeg = require('jpeg-js');

/** @type {number[] | undefined} */
let crc32Table;

const FONT_5X7 = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
    6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
    '&': ['01000', '10100', '10100', '01000', '10101', '10010', '01101'],
    '#': ['01010', '11111', '01010', '01010', '11111', '01010', '01010'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    ',': ['00000', '00000', '00000', '00000', '00000', '00100', '01000'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
    '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
    ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
    '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function colorToRgba(hex) {
    const value = String(hex || '').replace(/^#/, '');
    const n = parseInt(value.length === 3
        ? value.split('').map(ch => ch + ch).join('')
        : value, 16);
    return [
        (n >> 16) & 0xff,
        (n >> 8) & 0xff,
        n & 0xff,
        0xff,
    ];
}

function createPixelBuffer(width, height, color) {
    const pixels = Buffer.alloc(width * height * 4);
    const rgba = colorToRgba(color);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = rgba[0];
        pixels[i + 1] = rgba[1];
        pixels[i + 2] = rgba[2];
        pixels[i + 3] = rgba[3];
    }
    return pixels;
}

function setPixel(pixels, width, height, x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    const rgba = Array.isArray(color) ? color : colorToRgba(color);
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = rgba[3];
}

function fillRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
    const rgba = colorToRgba(color);
    for (let py = y; py < y + rectHeight; py++) {
        for (let px = x; px < x + rectWidth; px++) {
            setPixel(pixels, width, height, px, py, rgba);
        }
    }
}

function fillRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color) {
    const rgba = colorToRgba(color);
    for (let py = 0; py < rectHeight; py++) {
        for (let px = 0; px < rectWidth; px++) {
            const inTop = py < radius;
            const inBottom = py >= rectHeight - radius;
            const inLeft = px < radius;
            const inRight = px >= rectWidth - radius;
            if ((inTop && inLeft && (radius - px) ** 2 + (radius - py) ** 2 > radius ** 2)
                || (inTop && inRight && (px - (rectWidth - radius - 1)) ** 2 + (radius - py) ** 2 > radius ** 2)
                || (inBottom && inLeft && (radius - px) ** 2 + (py - (rectHeight - radius - 1)) ** 2 > radius ** 2)
                || (inBottom && inRight && (px - (rectWidth - radius - 1)) ** 2 + (py - (rectHeight - radius - 1)) ** 2 > radius ** 2)) {
                continue;
            }
            setPixel(pixels, width, height, x + px, y + py, rgba);
        }
    }
}

function drawText(pixels, width, height, text, x, y, color, scale = 2) {
    let cursorX = x;
    const rgba = colorToRgba(color);
    for (const rawChar of String(text || '')) {
        const glyph = FONT_5X7[rawChar.toUpperCase()] || FONT_5X7[' '];
        for (let gy = 0; gy < glyph.length; gy++) {
            for (let gx = 0; gx < glyph[gy].length; gx++) {
                if (glyph[gy][gx] !== '1') continue;
                fillRect(pixels, width, height, cursorX + gx * scale, y + gy * scale, scale, scale, color);
            }
        }
        cursorX += (5 + 1) * scale;
        void rgba;
    }
}

function crc32(buffer) {
    if (!crc32Table) {
        crc32Table = Array.from({ length: 256 }, (_value, index) => {
            let c = index;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            return c >>> 0;
        });
    }
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;  // bit depth
    header[9] = 6;  // RGBA
    header[10] = 0; // compression
    header[11] = 0; // filter
    header[12] = 0; // interlace

    const stride = width * 4;
    const scanlines = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        scanlines[y * (stride + 1)] = 0;
        pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(scanlines)),
        pngChunk('IEND'),
    ]);
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decodePng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
    if (buffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    let pos = 8;

    while (pos + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(pos);
        const type = buffer.slice(pos + 4, pos + 8).toString('ascii');
        const data = buffer.slice(pos + 8, pos + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += length + 12;
    }

    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || channels === 0 || idat.length === 0) return null;

    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const rowBytes = width * channels;
    const rgba = Buffer.alloc(width * height * 4);
    const previous = Buffer.alloc(rowBytes);
    const current = Buffer.alloc(rowBytes);
    let offset = 0;

    for (let y = 0; y < height; y++) {
        const filter = inflated[offset++];
        inflated.copy(current, 0, offset, offset + rowBytes);
        offset += rowBytes;

        for (let x = 0; x < rowBytes; x++) {
            const left = x >= channels ? current[x - channels] : 0;
            const up = previous[x] || 0;
            const upLeft = x >= channels ? previous[x - channels] || 0 : 0;
            if (filter === 1) current[x] = (current[x] + left) & 0xff;
            else if (filter === 2) current[x] = (current[x] + up) & 0xff;
            else if (filter === 3) current[x] = (current[x] + Math.floor((left + up) / 2)) & 0xff;
            else if (filter === 4) current[x] = (current[x] + paethPredictor(left, up, upLeft)) & 0xff;
        }

        for (let x = 0; x < width; x++) {
            const src = x * channels;
            const dst = (y * width + x) * 4;
            if (channels === 1) {
                rgba[dst] = current[src];
                rgba[dst + 1] = current[src];
                rgba[dst + 2] = current[src];
                rgba[dst + 3] = 255;
            } else {
                rgba[dst] = current[src];
                rgba[dst + 1] = current[src + 1];
                rgba[dst + 2] = current[src + 2];
                rgba[dst + 3] = channels === 4 ? current[src + 3] : 255;
            }
        }
        current.copy(previous);
    }

    return { width, height, pixels: rgba };
}

function decodeJpeg(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    try {
        const image = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 128 });
        if (!image?.width || !image?.height || !image.data) return null;
        return { width: image.width, height: image.height, pixels: Buffer.from(image.data) };
    } catch {
        return null;
    }
}

function decodeRasterImage(buffer) {
    return decodePng(buffer) || decodeJpeg(buffer);
}

function blendPixel(pixels, width, height, x, y, rgba) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const alpha = rgba[3] / 255;
    const offset = (y * width + x) * 4;
    pixels[offset] = Math.round(rgba[0] * alpha + pixels[offset] * (1 - alpha));
    pixels[offset + 1] = Math.round(rgba[1] * alpha + pixels[offset + 1] * (1 - alpha));
    pixels[offset + 2] = Math.round(rgba[2] * alpha + pixels[offset + 2] * (1 - alpha));
    pixels[offset + 3] = 255;
}

function drawImageCoverCircle(pixels, width, height, image, x, y, size) {
    if (!image) return false;
    const scale = Math.max(size / image.width, size / image.height);
    const srcWidth = size / scale;
    const srcHeight = size / scale;
    const srcLeft = (image.width - srcWidth) / 2;
    const srcTop = (image.height - srcHeight) / 2;
    const radius = size / 2;
    const center = radius - 0.5;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const dx = px - center;
            const dy = py - center;
            if (dx * dx + dy * dy > radius * radius) continue;
            const sx = Math.max(0, Math.min(image.width - 1, Math.floor(srcLeft + px / scale)));
            const sy = Math.max(0, Math.min(image.height - 1, Math.floor(srcTop + py / scale)));
            const src = (sy * image.width + sx) * 4;
            blendPixel(pixels, width, height, x + px, y + py, [
                image.pixels[src],
                image.pixels[src + 1],
                image.pixels[src + 2],
                image.pixels[src + 3],
            ]);
        }
    }
    return true;
}

module.exports = { colorToRgba, createPixelBuffer, fillRect, fillRoundedRect, drawText, encodePng, decodeRasterImage, drawImageCoverCircle };
