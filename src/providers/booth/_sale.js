'use strict';

// ============================================================================
// booth.pm 商品の販売期間 (sale period) 抽出ユーティリティ。
//
// booth.pm の `<URL>.json` レスポンスは商品によって含まれるフィールド名が
// 異なり、また pre-release / 期間限定セールで使われるキーが複数候補ある。
// 既知のものを総当たりで探し、{ startAt, endAt, raw } を返す。
//
// 検出キー (商品レベル / variation レベル両方を見る):
//   sales_period:        { starts_at, ends_at }
//   sale_period:         { starts_at, ends_at }
//   sales_started_at / sales_ended_at
//   sale_started_at  / sale_ended_at
//   sale_starts_at   / sale_ends_at
//   discount_starts_at / discount_ends_at
//
// 何も見つからなければ null を返す (= 販売期間情報なし)。
// ============================================================================

const PERIOD_OBJ_KEYS = ['sales_period', 'sale_period'];
const START_KEYS = [
    'sales_started_at', 'sale_started_at',
    'sales_starts_at', 'sale_starts_at',
    'discount_starts_at',
];
const END_KEYS = [
    'sales_ended_at', 'sale_ended_at',
    'sales_ends_at', 'sale_ends_at',
    'discount_ends_at',
];

function parseDateLike(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d;
}

function pickFromObject(obj) {
    if (!obj || typeof obj !== 'object') return { startAt: null, endAt: null };
    let startAt = null;
    let endAt = null;

    for (const key of PERIOD_OBJ_KEYS) {
        const periodObj = obj[key];
        if (periodObj && typeof periodObj === 'object') {
            startAt = startAt || parseDateLike(periodObj.starts_at || periodObj.start_at || periodObj.started_at);
            endAt   = endAt   || parseDateLike(periodObj.ends_at   || periodObj.end_at   || periodObj.ended_at);
        }
    }

    for (const k of START_KEYS) {
        if (startAt) break;
        startAt = parseDateLike(obj[k]);
    }
    for (const k of END_KEYS) {
        if (endAt) break;
        endAt = parseDateLike(obj[k]);
    }

    return { startAt, endAt };
}

/**
 * info から販売期間を抽出する。商品レベル → variation レベルの順で探す。
 * @returns {{startAt: Date|null, endAt: Date|null} | null}
 */
function extractSalePeriod(info) {
    if (!info || typeof info !== 'object') return null;

    const top = pickFromObject(info);
    let startAt = top.startAt;
    let endAt   = top.endAt;

    if (!startAt && !endAt && Array.isArray(info.variations)) {
        for (const v of info.variations) {
            const got = pickFromObject(v);
            if (got.startAt && (!startAt || got.startAt < startAt)) startAt = got.startAt;
            if (got.endAt   && (!endAt   || got.endAt   > endAt))   endAt   = got.endAt;
            if (startAt && endAt) break;
        }
    }

    if (!startAt && !endAt) return null;
    return { startAt, endAt };
}

module.exports = { extractSalePeriod };
