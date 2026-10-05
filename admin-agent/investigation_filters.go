package main

import (
	"net/url"
	"strings"
)

// JSON field names are fixed by the server; values always remain bound parameters.
// Older event versions used snake_case, so both encodings are searchable.
func investigationFilters(q url.Values, payload string, includeGuild bool) (string, []any) {
	fields := [][3]string{{"channelId", "channelId", "channel_id"}, {"userId", "userId", "user_id"}, {"messageId", "messageId", "message_id"}}
	if includeGuild {
		fields = append(fields, [3]string{"guildId", "guildId", "guild_id"})
	}
	var clauses []string
	var args []any
	for _, field := range fields {
		if value := strings.TrimSpace(q.Get(field[0])); value != "" {
			clauses = append(clauses, "COALESCE(json_extract("+payload+",'$."+field[1]+"'),json_extract("+payload+",'$."+field[2]+"'),'')=?")
			args = append(args, value)
		}
	}
	if len(clauses) == 0 {
		return "", args
	}
	return " AND " + strings.Join(clauses, " AND "), args
}

// The UI checks this receipt before presenting a narrowed result from an older agent.
func appliedInvestigationFilters(q url.Values) Object {
	filters := Object{}
	for _, key := range []string{"guildId", "channelId", "userId", "messageId", "from", "to"} {
		if value := q.Get(key); value != "" {
			filters[key] = value
		}
	}
	return filters
}
