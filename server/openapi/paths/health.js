import { op, jsonBody, idParam } from '../helpers.js';

export function healthPaths() {
  return {
    '/api/v1/health/vitals': {
      get: op({ summary: 'List vital measurements', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` filters to a family member (only their `family`-visible rows). Optional `type`, `from`, `to` filters.' }),
      post: op({ summary: 'Create a vital measurement', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/vitals/{id}': {
      patch: op({ summary: 'Update a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications': {
      get: op({ summary: 'List medications', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` and `?active=` filters supported.' }),
      post: op({ summary: 'Create a medication', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/medications/{id}': {
      patch: op({ summary: 'Update a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a medication', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/schedules': {
      get: op({ summary: 'List a medication\'s intake schedules', tag: 'Health', params: [idParam()] }),
      post: op({ summary: 'Add an intake schedule to a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/schedules/{id}': {
      patch: op({ summary: 'Update an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/logs': {
      get: op({ summary: 'List a medication\'s dose log', tag: 'Health', params: [idParam()], description: 'Optional `from`/`to` filters on `scheduled_at`.' }),
      post: op({ summary: 'Add a dose-log entry', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}': {
      patch: op({
        summary: 'Correct a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { status?, taken_at?, dose_qty?, note? } (#701). `status: "pending"` undoes a take or a skip. The timestamp travels with the status rather than beside it: anything other than `taken` clears `taken_at`, because a dose that was not taken cannot carry a time it was taken at - and that entry would end up in the CSV export too. Restricted to the owner of the medication.',
      }),
      delete: op({
        summary: 'Delete a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        description: 'Only for entries without a schedule, so ad-hoc and as-needed doses (#701). A scheduled entry answers `409`: the scheduler would recreate it on its next run, so deleting it would look like a success and be a return on the instalment plan. Undo it with `PATCH { status: "pending" }` instead.',
      }),
    },
    '/api/v1/health/logs/{id}/take': {
      post: op({ summary: 'Mark a dose as taken', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}/skip': {
      post: op({ summary: 'Mark a dose as skipped', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs': {
      get: op({ summary: 'List lab reports (with results)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create a lab report with analyte results', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs/{id}': {
      get: op({ summary: 'Get a lab report (with results)', tag: 'Health', params: [idParam()] }),
      patch: op({ summary: 'Update lab report header fields', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a lab report', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/labs/{id}/results': {
      post: op({ summary: 'Add an analyte result to a lab report', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/results/{id}': {
      delete: op({ summary: 'Delete an analyte result', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/activities': {
      get: op({ summary: 'List activities', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `type`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create an activity', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/activities/{id}': {
      patch: op({ summary: 'Update an activity', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an activity', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/export/vitals': {
      get: op({ summary: 'Export vital measurements as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/activities': {
      get: op({ summary: 'Export activities as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/labs': {
      get: op({ summary: 'Export lab reports (one row per analyte) as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/meds-logs': {
      get: op({ summary: 'Export medication dose logs as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/cycle/periods': {
      get: op({ summary: 'List menstrual period episodes', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Log a menstrual period episode', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/periods/{id}': {
      patch: op({ summary: 'Update a period episode', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a period episode', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/logs': {
      get: op({ summary: 'List cycle day logs (flow, symptoms, mood)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Upsert a cycle day log (one per person and day)', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/logs/{id}': {
      delete: op({ summary: 'Delete a cycle day log', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/settings': {
      get: op({ summary: 'Get the viewer\'s cycle prediction settings', tag: 'Health' }),
      put: op({ summary: 'Update the viewer\'s cycle prediction settings', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/export/cycle': {
      get: op({ summary: 'Export period history as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/caregivers/me': {
      get: op({ summary: 'List who the caller may record health data for', tag: 'Health', description: 'Open to every member: it is the answer about their own rights, not about anyone else\'s data.' }),
    },
    '/api/v1/health/caregivers': {
      get: op({ summary: 'List all caregiver relationships', tag: 'Health', admin: true, description: 'Returns `{ subject_id: [caregiver_id, ...] }` for the admin rights matrix.' }),
    },
    '/api/v1/health/caregivers/{subjectId}': {
      put: op({ summary: 'Set who may record health data for one person', tag: 'Health', admin: true, stateChanging: true, params: [idParam('subjectId', 'The person being cared for')], requestBody: jsonBody(null), description: 'Sets the caregivers to exactly the list given. An empty array withdraws care, so removing is the same path as changing and needs no route of its own.' }),
    },
    '/api/v1/health/cycle/visibility': {
      patch: op({ summary: 'Set the visibility of all own cycle entries at once', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Applies one visibility to every period and daily log of the CALLER. Other people\'s entries are untouched, and periods and logs move together in one transaction - either both or neither.' }),
    },
    '/api/v1/health/visibility-defaults': {
      get: op({ summary: 'Get the caller\'s default visibility per health area', tag: 'Health', description: 'Returns only the deviations as `{ scope_key: visibility }`; a missing key means `private`, the shipped value. Scope keys are `vital:<type>` per metric plus `meds`, `labs` and `activities`. The cycle tab keeps its own setting under `/health/cycle/settings`.' }),
      put: op({ summary: 'Set the caller\'s default visibility for one or more areas', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ defaults: { "vital:bp": "family", ... } }`. Named keys are replaced, unnamed ones stay. Setting `private` DELETES the row rather than storing it, so "no row" remains the only spelling of the default. Affects new entries only; a value given on the entry itself always wins.' }),
    },
    '/api/v1/health/visibility-defaults/apply': {
      patch: op({ summary: 'Move existing entries of one area to a visibility', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ scope, visibility }`. Touches the CALLER\'s own rows only, and only in the named area - a caregiver may tend individual entries but not relabel somebody else\'s history in one move. The target comes from the request rather than from the stored default, because `private` is not stored at all.' }),
    },
  };
}
