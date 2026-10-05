'use strict';

function stockState(value) {
    const status = String(value?.status || value?.sale_status || '').toLowerCase();
    if (['out_of_sale_period', 'before_sale', 'ended', 'private', 'unpublished'].includes(status)) return 'unavailable';
    if (value?.is_sold_out === true || value?.is_empty_stock === true || value?.is_waiting_on_arrival === true || status === 'sold_out') return 'sold_out';
    if (['available', 'on_sale', 'in_stock', 'free_download'].includes(status) || value?.is_available === true
        || value?.is_empty_stock === false && typeof value?.order_url === 'string' && value.order_url.length > 0) return 'available';
    return 'unknown';
}

function parseStock(info) {
    const variations = (Array.isArray(info?.variations) ? info.variations : []).filter(v => /^\d{1,20}$/.test(String(v.id)))
        .map(v => ({ id: String(v.id), name: String(v.name || v.id).slice(0, 100), state: stockState(v) }));
    const direct = stockState(info);
    const state = direct === 'unavailable' || variations.length && variations.every(v => v.state === 'unavailable') ? 'unavailable' : variations.some(v => v.state === 'available') ? 'available'
        : variations.length && variations.every(v => v.state === 'sold_out') ? 'sold_out'
            : direct === 'sold_out' ? 'sold_out' : variations.length ? 'unknown' : direct;
    return { state, variations: direct === 'unavailable' ? variations.map(v => ({ ...v, state: 'unavailable' })) : variations };
}

function restockOptions(info) {
    const stock = parseStock(info);
    return [ ...(stock.state === 'sold_out' ? [{ id: '*', name: '商品全体 / Any variation' }] : []),
        ...stock.variations.filter(v => v.state === 'sold_out').map(v => ({ id: v.id, name: v.name })) ];
}
module.exports = { stockState, parseStock, restockOptions };
