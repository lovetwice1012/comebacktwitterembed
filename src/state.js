'use strict';

// 横断的に共有される可変ステート。
// オブジェクト経由で参照することでモジュール間の参照共有を保つ。

const counters = {
    processed: 0,
    processed_hour: 0,
    processed_day: 0,
};

const consoleBuffer = {
    text: '',
};

module.exports = { counters, consoleBuffer };
