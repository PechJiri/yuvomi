import { op, jsonBody, idParam } from '../helpers.js';

export function housekeepingPaths() {
  return {
    '/api/v1/housekeeping/dashboard': {
      get: op({ summary: 'Get housekeeping dashboard', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/task-templates': {
      get: op({ summary: 'List housekeeping task templates', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/worker': {
      get: op({ summary: 'Get primary housekeeper profile', tag: 'Housekeeping' }),
      post: op({ summary: 'Create or update housekeeper profile', tag: 'Housekeeping', admin: true, stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/workers': {
      get: op({ summary: 'List housekeeper profiles', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/summary': {
      get: op({ summary: 'Get monthly housekeeping summary', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/work-sessions': {
      get: op({ summary: 'List housekeeping work sessions for a month', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/work-sessions/check-in': {
      post: op({ summary: 'Check in a housekeeper', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/work-sessions/check-out': {
      post: op({ summary: 'Check out a housekeeper', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/visits': {
      get: op({ summary: 'List housekeeping visits for a month', tag: 'Housekeeping' }),
    },
    '/api/v1/housekeeping/visits/{id}': {
      get: op({ summary: 'Get housekeeping visit', tag: 'Housekeeping', params: [idParam()] }),
      put: op({ summary: 'Update housekeeping visit', tag: 'Housekeeping', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete housekeeping visit', tag: 'Housekeeping', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/housekeeping/visits/{id}/pay': {
      post: op({ summary: 'Mark housekeeping visit as paid', tag: 'Housekeeping', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/housekeeping/decay-tasks': {
      get: op({ summary: 'List housekeeping decay tasks', tag: 'Housekeeping' }),
      post: op({ summary: 'Create housekeeping decay task', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}': {
      patch: op({ summary: 'Update housekeeping decay task', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete housekeeping decay task', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true }),
    },
    '/api/v1/housekeeping/decay-tasks/{taskId}/complete': {
      post: op({ summary: 'Mark housekeeping decay task complete', tag: 'Housekeeping', params: [idParam('taskId', 'Decay task ID')], stateChanging: true }),
    },
    '/api/v1/housekeeping/supply-requests': {
      post: op({ summary: 'Create housekeeping supply request and shopping item', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/housekeeping/maintenance-log': {
      get: op({ summary: 'List housekeeping maintenance log entries', tag: 'Housekeeping' }),
      post: op({ summary: 'Create housekeeping maintenance log entry', tag: 'Housekeeping', stateChanging: true, requestBody: jsonBody(null) }),
    },
  };
}
