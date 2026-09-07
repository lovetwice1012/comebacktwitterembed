'use strict';

const { ensureDatabaseSchema, TABLES } = require('../src/db_schema');
const { queryDatabase, closeDatabaseConnection } = require('../src/db');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DAYS = 14;
const LOCK_NAME = 'cbte_metric_observation_rollup_backfill_v1';

function numericArg(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive millisecond timestamp or number.`);
    return Math.floor(parsed);
}

function parseArgs(argv) {
    const args = { days: DEFAULT_DAYS, startMs: null, endMs: Date.now(), rebuild: false, dryRun: false };
    for (const arg of argv) {
        if (arg === '--rebuild') args.rebuild = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg.startsWith('--days=')) args.days = Number(arg.slice(7));
        else if (arg.startsWith('--start=')) args.startMs = numericArg(arg.slice(8), '--start');
        else if (arg.startsWith('--end=')) args.endMs = numericArg(arg.slice(6), '--end');
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!Number.isFinite(args.days) || args.days <= 0 || args.days > 90) throw new Error('--days must be between 1 and 90.');
    const startMs = args.startMs ?? args.endMs - args.days * 24 * HOUR_MS;
    args.startMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
    args.endMs = Math.ceil(args.endMs / HOUR_MS) * HOUR_MS;
    if (args.startMs >= args.endMs) throw new Error('Backfill start must be before end.');
    return args;
}

function hourInsertSql() {
    return `INSERT IGNORE INTO ${TABLES.botProviderMetricObservationHourly} (
        bucket_start_ms, provider_id, account_key, facet_key, subject_hash, subject_key,
        content_event_id, facet_id, occurred_at_ms, observed_at_ms, author_user_id, guild_id,
        content_type, numeric_value
    )
    SELECT ranked.bucket_start_ms,ranked.provider_id,ranked.account_key,ranked.facet_key,ranked.subject_hash,ranked.subject_key,
      ranked.content_event_id,ranked.facet_id,ranked.occurred_at_ms,ranked.observed_at_ms,ranked.author_user_id,ranked.guild_id,
      ranked.content_type,ranked.numeric_value
    FROM (
      SELECT source.*,UNHEX(SHA2(subject_key,256)) AS subject_hash,
        ROW_NUMBER() OVER (
          PARTITION BY bucket_start_ms,provider_id,facet_key,UNHEX(SHA2(subject_key,256))
          ORDER BY observed_at_ms DESC,content_event_id DESC,facet_id DESC
        ) AS row_rank
      FROM (
        SELECT FLOOR(c.occurred_at_ms / 3600000) * 3600000 AS bucket_start_ms,
          f.provider_id,f.account_key,f.facet_key,
          f.content_event_id,f.facet_id,c.occurred_at_ms,
          COALESCE(f.collected_at_ms,c.occurred_at_ms) AS observed_at_ms,
          c.author_user_id,c.guild_id,c.content_type,f.numeric_value,
          CASE WHEN f.facet_key REGEXP '[.](followers|subscribers|following|follower_count|subscriber_count)$'
            THEN CONCAT('account:',COALESCE(NULLIF(f.account_key,''),CONCAT('unknown:',c.content_event_id)))
            ELSE CONCAT('content:',COALESCE(NULLIF(c.content_id,''),NULLIF(c.normalized_url,''),NULLIF(c.content_url,''),CONCAT('unknown:',c.content_event_id))) END AS subject_key
        FROM ${TABLES.botProviderContentFacets} f
        JOIN ${TABLES.botProviderContentEvents} c ON c.content_event_id=f.content_event_id
        WHERE c.occurred_at_ms >= ? AND c.occurred_at_ms < ?
      ) source
    ) ranked
    WHERE row_rank=1
    `;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    console.log(JSON.stringify({ action: 'metric_observation_rollup_backfill', ...args }));
    if (args.dryRun) return args;
    await ensureDatabaseSchema();
    const lock = await queryDatabase(`SELECT GET_LOCK(?, 5) AS acquired`, [LOCK_NAME]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error('Another metric rollup backfill is running.');
    try {
        if (args.rebuild) {
            await queryDatabase(
                `DELETE FROM ${TABLES.botProviderMetricObservationHourly} WHERE bucket_start_ms >= ? AND bucket_start_ms < ?`,
                [args.startMs, args.endMs],
            );
        }
        const sql = hourInsertSql();
        let totalAffected = 0;
        for (let bucket = args.startMs; bucket < args.endMs; bucket += HOUR_MS) {
            const result = await queryDatabase(sql, [bucket, bucket + HOUR_MS]);
            const affected = Number(result?.affectedRows || 0);
            totalAffected += affected;
            console.log(JSON.stringify({ bucketStartMs: bucket, affectedRows: affected, totalAffected }));
        }
        console.log(JSON.stringify({ action: 'metric_observation_rollup_backfill_complete', coverageStartMs: args.startMs, coverageEndMs: args.endMs, totalAffected }));
        return { ...args, totalAffected };
    } finally {
        await queryDatabase(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]).catch(() => {});
    }
}

if (require.main === module) {
    main()
        .catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => closeDatabaseConnection());
}

module.exports = { main, parseArgs, hourInsertSql };
