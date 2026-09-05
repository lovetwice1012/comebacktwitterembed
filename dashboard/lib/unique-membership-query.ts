function splitProjection(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

// Only the known single-table membership aggregates are rewritten. Other
// SQL, joins, nested predicates and non-group projections remain untouched.
export function compactUniqueMembershipCount(sql: string) {
  const match = sql.match(/^\s*SELECT\s+([\s\S]*?)COUNT\s*\(\s*DISTINCT\s+key_hash\s*\)\s+AS\s+(\w+)\s+FROM\s+bot_provider_hourly_unique_keys\s+WHERE\s+([\s\S]*?)\s*;?\s*$/i);
  if (!match || /\/\*|\b(?:SELECT|JOIN|UNION|HAVING)\b/i.test(match[1] + match[3])) return sql;
  const [, prefix, countAlias, remainder] = match;
  const sourceHint = /event_type\s*=\s*'provider_content'/i.test(remainder)
    ? '/*+ INDEX(bot_provider_hourly_unique_keys idx_provider_hourly_unique_event_key_time) */ ' : '';
  const groupAt = remainder.search(/\bGROUP\s+BY\b/i);
  if (groupAt < 0) {
    if (prefix.trim() || /\bORDER\s+BY|\bLIMIT\b/i.test(remainder)) return sql;
    return `SELECT COUNT(members.key_hash) AS ${countAlias}
      FROM (SELECT ${sourceHint}DISTINCT key_hash FROM bot_provider_hourly_unique_keys WHERE ${remainder}) members`;
  }
  if (!prefix.trim().endsWith(',')) return sql;
  const where = remainder.slice(0, groupAt).trim();
  const grouped = remainder.slice(groupAt).replace(/^GROUP\s+BY\s+/i, '');
  const suffixAt = grouped.search(/\bORDER\s+BY\b|\bLIMIT\b/i);
  const groupText = (suffixAt < 0 ? grouped : grouped.slice(0, suffixAt)).trim();
  const suffix = suffixAt < 0 ? '' : grouped.slice(suffixAt);
  const groups = groupText.split(',').map(value => value.trim());
  if (groups.some(value => !/^\w+$/.test(value) || value.toLowerCase() === 'key_hash')) return sql;
  const projection = prefix.trim().slice(0, -1).trim();
  const aliases = splitProjection(projection).map(value => value.match(/\s+AS\s+(\w+)$/i)?.[1] || (/^\w+$/.test(value) ? value : ''));
  if (aliases.length !== groups.length || aliases.some(value => !value || !groups.some(group => group.toLowerCase() === value.toLowerCase()))) return sql;
  return `SELECT /*+ SET_VAR(tmp_table_size=2147483648) */ ${aliases.map(value => `members.${value}`).join(',')},
    COUNT(members.key_hash) AS ${countAlias}
    FROM (SELECT ${sourceHint}DISTINCT ${projection},key_hash FROM bot_provider_hourly_unique_keys WHERE ${where}) members
    GROUP BY ${groups.map(value => `members.${value}`).join(',')} ${suffix}`;
}
