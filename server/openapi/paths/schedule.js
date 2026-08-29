import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

/**
 * Schichtplan (#786).
 *
 * `/entries` ist die einzige Route, die rechnet statt zu speichern: sie loest
 * Muster und Ausnahmen zum Lesezeitpunkt auf und legt nichts in
 * `calendar_events` ab. Der Zeitraum ist begrenzt - ohne Grenze baut ein Aufruf
 * einen Eintrag je Tag und Mitglied.
 */
export function schedulePaths() {
  return {
    '/api/v1/schedule/entries': {
      get: op({
        summary: 'Resolve schedule entries for a date range',
        description: 'Computed from patterns and overrides at read time; nothing is written to the calendar. The range is capped at 731 days.',
        tag: 'Schedule',
        params: [
          { name: 'from', in: 'query', required: true, description: 'Start date (YYYY-MM-DD)', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, description: 'End date (YYYY-MM-DD), inclusive', schema: { type: 'string', format: 'date' } },
          { name: 'user_id', in: 'query', required: false, description: 'Limit to one household member', schema: { type: 'integer' } },
        ],
      }),
    },
    '/api/v1/schedule/shift-types': {
      get: op({ summary: 'List shift types', tag: 'Schedule' }),
      post: op({ summary: 'Create a shift type', description: 'Any member may add one.', tag: 'Schedule', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/shift-types/{id}': {
      put: op({ summary: 'Update a shift type', description: 'Only its creator or an administrator.', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a shift type', description: 'Only its creator or an administrator. Answers 409 while a pattern or override still references it.', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/patterns': {
      get: op({ summary: 'List cycle patterns', tag: 'Schedule' }),
      post: op({ summary: 'Create a cycle pattern', tag: 'Schedule', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/patterns/{id}': {
      put: op({ summary: 'Update a cycle pattern', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a cycle pattern', description: 'Its cycle days go with it.', tag: 'Schedule', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/schedule/patterns/{id}/days': {
      get: op({ summary: 'List the cycle days of a pattern', tag: 'Schedule', params: [idParam()] }),
      put: op({ summary: 'Replace all cycle days of a pattern', tag: 'Schedule', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/schedule/patterns/{id}/days/{position}': {
      put: op({
        summary: 'Set one cycle day',
        description: 'A NULL shift type is a free day within the cycle.',
        tag: 'Schedule',
        params: [idParam(), { name: 'position', in: 'path', required: true, description: 'Zero-based position within the cycle', schema: { type: 'integer' } }],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/overrides': {
      get: op({ summary: 'List per-day overrides', tag: 'Schedule' }),
      delete: op({
        summary: 'Remove overrides across a date range',
        description: 'The counterpart to /overrides/fill - a single indexed delete, so it carries the read-side range cap (731 days) rather than the smaller one on fill.',
        tag: 'Schedule',
        params: [
          { name: 'user_id', in: 'query', required: true, description: 'Household member', schema: { type: 'integer' } },
          { name: 'from', in: 'query', required: true, description: 'Start date (YYYY-MM-DD)', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, description: 'End date (YYYY-MM-DD), inclusive', schema: { type: 'string', format: 'date' } },
        ],
        stateChanging: true,
      }),
    },
    '/api/v1/schedule/overrides/fill': {
      post: op({
        summary: 'Fill a date range of overrides in one call',
        description: 'Upserts the same shift type (or NULL for a free day) across an inclusive range - e.g. marking a vacation - instead of one PUT per day. Writes real rows, so it is capped separately from /entries at 100 days.',
        tag: 'Schedule',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/schedule/overrides/{dateKey}': {
      put: op({
        summary: 'Set a per-day override',
        description: 'A NULL shift type is an explicit day off, which is why deleting the override is the only way back to the pattern.',
        tag: 'Schedule',
        params: [stringPathParam('dateKey', 'Date (YYYY-MM-DD)')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Remove a per-day override', tag: 'Schedule', params: [stringPathParam('dateKey', 'Date (YYYY-MM-DD)')], stateChanging: true }),
    },
  };
}
