import { op, jsonBody, idParam } from '../helpers.js';

export function birthdaysPaths() {
  return {
    '/api/v1/birthdays': {
      get: op({ summary: 'List birthdays', tag: 'Birthdays' }),
      post: op({
        summary: 'Create birthday',
        description: 'Optional `name_day` uses `MM-DD` (month and day only). When set, it creates a separate yearly calendar occurrence and uses the same `reminder_offset` as the birthday.',
        tag: 'Birthdays',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/birthdays/upcoming': {
      get: op({
        summary: 'List upcoming birthdays',
        description: 'Ordered by distance to each person’s next birthday; optional name-day fields do not affect ordering.',
        tag: 'Birthdays',
      }),
    },
    '/api/v1/birthdays/import/candidates': {
      get: op({ summary: 'List contacts eligible for birthday import', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/import': {
      post: op({ summary: 'Import selected contacts as birthdays', tag: 'Birthdays', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/birthdays/meta/options': {
      get: op({ summary: 'Get birthday upload options', tag: 'Birthdays' }),
    },
    '/api/v1/birthdays/{id}': {
      put: op({
        summary: 'Update birthday',
        description: 'Optional `name_day` uses `MM-DD`; send `null` to clear it and remove its generated calendar event and reminder. Omitted fields remain unchanged.',
        tag: 'Birthdays',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
      delete: op({ summary: 'Delete birthday', tag: 'Birthdays', params: [idParam()], stateChanging: true }),
    },
  };
}
