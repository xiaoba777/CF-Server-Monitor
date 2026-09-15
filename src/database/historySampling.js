import { HISTORY_INSERT_COLUMNS } from '../utils/historyFields.js';

const SPARSE_HISTORY_MIN_HOURS = 1;

export function validateHistoryColumns(columns) {
  const columnList = columns.split(',').map(column => column.trim()).filter(Boolean);
  if (!columnList.some(column => column !== 'timestamp') || columnList.some(column => !HISTORY_INSERT_COLUMNS.includes(column))) {
    throw new Error('Invalid history columns');
  }
  return columnList;
}

// Timestamp index seeks also support imported legacy IDs. Explicit BIGINT parameters
// avoid PostgreSQL inferring text/32-bit integers; no timezone/date conversion is needed.
export function buildPostgresSparseHistoryQuery({ columns, serverId, queryStart, queryEnd, firstRangeEnd, intervalMs, oldTableExists, sampleOrder = 'ASC' }) {
  const columnList = validateHistoryColumns(columns).filter(column => column !== 'timestamp');
  if (!serverId || ![queryStart, queryEnd, firstRangeEnd, intervalMs].every(Number.isFinite)
    || intervalMs < 1 || firstRangeEnd <= queryStart || queryEnd <= queryStart) {
    throw new Error('Invalid sparse history range');
  }
  const bindValues = [];
  const ranges = [];
  let rangeStart = queryStart;
  let rangeEnd = Math.min(firstRangeEnd, queryEnd);
  while (rangeStart < queryEnd) {
    if (ranges.length >= 1000) throw new Error('Too many history buckets');
    ranges.push('(?::bigint, ?::bigint)');
    bindValues.push(Math.floor(rangeStart), Math.floor(rangeEnd));
    rangeStart = rangeEnd;
    rangeEnd = Math.min(queryEnd, rangeEnd + intervalMs);
  }
  const order = String(sampleOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const tables = oldTableExists ? ['metrics_history', 'metrics_history_old'] : ['metrics_history'];
  const sources = tables.map(tableName => {
    bindValues.push(serverId);
    return `(SELECT timestamp, ${columnList.join(', ')} FROM ${tableName}
      WHERE server_id = ? AND timestamp >= ranges.range_start AND timestamp < ranges.range_end
      ORDER BY timestamp ${order}, id ${order} LIMIT 1)`;
  });
  return {
    sql: `WITH ranges(range_start, range_end) AS (VALUES ${ranges.join(', ')})
      SELECT (SELECT row_to_json(sample) FROM (
        SELECT * FROM (${sources.join(' UNION ALL ')}) AS candidates
        ORDER BY timestamp ${order} LIMIT 1
      ) AS sample) AS sample_json
      FROM ranges ORDER BY range_start ASC`,
    bindValues
  };
}

export function shouldUseSparseHistorySampling(
  queryHours,
  currentUsesIdRange,
  oldTableExists,
  oldUsesIdRange
) {
  return queryHours > SPARSE_HISTORY_MIN_HOURS
    && currentUsesIdRange
    && (!oldTableExists || oldUsesIdRange);
}

function buildSampleJsonExpression(tableName, jsonColumns, sampleOrder) {
  return `(
    SELECT json_object(${jsonColumns})
    FROM ${tableName}
    WHERE id >= ranges.start_id
      AND id < ranges.end_id
    ORDER BY id ${sampleOrder}
    LIMIT 1
  )`;
}

export function buildSparseHistoryQuery({
  columns,
  queryStart,
  queryEnd,
  firstRangeEnd,
  intervalMs,
  idPrefix,
  oldTableExists,
  tableBoundary,
  sampleOrder = 'ASC'
}) {
  const columnList = validateHistoryColumns(columns);
  const jsonColumns = ['timestamp', ...columnList]
    .flatMap(column => [`'${column}'`, column])
    .join(', ');
  const normalizedSampleOrder = String(sampleOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const bindValues = [
    queryStart,
    firstRangeEnd,
    intervalMs,
    queryEnd,
    queryEnd,
    idPrefix,
    idPrefix
  ];
  const currentSample = buildSampleJsonExpression('metrics_history', jsonColumns, normalizedSampleOrder);
  let sampleExpression = currentSample;

  if (oldTableExists) {
    const oldSample = buildSampleJsonExpression('metrics_history_old', jsonColumns, normalizedSampleOrder);
    sampleExpression = `COALESCE(
        CASE WHEN ranges.range_start < ? THEN ${oldSample} END,
        CASE WHEN ranges.range_end > ? THEN ${currentSample} END
      )`;
    bindValues.push(tableBoundary, tableBoundary);
  }

  return {
    sql: `
      WITH RECURSIVE sample_ranges(range_start, range_end) AS (
        SELECT ?, ?
        UNION ALL
        SELECT
          range_end,
          MIN(range_end + ?, ?)
        FROM sample_ranges
        WHERE range_end < ?
      ),
      id_ranges AS (
        SELECT
          range_start,
          range_end,
          ? + CAST(
            substr(
              strftime(
                '%Y%m%d%H%M%S',
                CAST(range_start / 1000 AS INTEGER),
                'unixepoch'
              ),
              3
            ) AS INTEGER
          ) AS start_id,
          ? + CAST(
            substr(
              strftime(
                '%Y%m%d%H%M%S',
                CAST(range_end / 1000 AS INTEGER),
                'unixepoch'
              ),
              3
            ) AS INTEGER
          ) AS end_id
        FROM sample_ranges
      )
      SELECT ${sampleExpression} AS sample_json
      FROM id_ranges AS ranges
      ORDER BY ranges.range_start ASC
    `,
    bindValues
  };
}
