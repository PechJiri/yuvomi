import { op, jsonBody, idParam } from '../helpers.js';

export function splitexpensesPaths() {
  return {
    '/api/v1/split-expenses/meta': { get: op({ summary: 'Get split expenses metadata', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/dashboard': { get: op({ summary: 'Get split expenses dashboard summary', tag: 'SplitExpenses' }) },
    '/api/v1/split-expenses/groups': {
      get: op({ summary: 'List expense groups', tag: 'SplitExpenses' }),
      post: op({ summary: 'Create expense group', tag: 'SplitExpenses', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}': {
      patch: op({ summary: 'Update expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/archive': {
      post: op({ summary: 'Archive expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/unarchive': {
      post: op({ summary: 'Restore an archived expense group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/members': {
      get: op({ summary: 'List group members', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Add member to group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/member-candidates': {
      get: op({ summary: 'List users and contacts that can be added to a group', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/members/{userId}': {
      delete: op({ summary: 'Remove member from group', tag: 'SplitExpenses', params: [idParam(), { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }], stateChanging: true }),
    },
    '/api/v1/split-expenses/groups/{id}/guests': {
      post: op({ summary: 'Create a guest user and add them to a group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/expenses': {
      get: op({ summary: 'List group expenses', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create expense in group (optional `attachment_document_ids`: receipts from the documents module, filtered by document visibility)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/balances': {
      get: op({ summary: 'Get group balances', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/settlements': {
      post: op({ summary: 'Record settlement (optional `proof_document_id`: one payment proof, ignored when the document is not visible to the caller)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/groups/{id}/activity': {
      get: op({ summary: 'Get group activity feed', tag: 'SplitExpenses', params: [idParam()] }),
    },
    '/api/v1/split-expenses/groups/{id}/recurring': {
      get: op({ summary: 'List recurring expenses in group', tag: 'SplitExpenses', params: [idParam()] }),
      post: op({ summary: 'Create recurring expense in group', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/expenses/{id}': {
      put: op({ summary: 'Update expense (`attachment_document_ids` replaces the receipt links; omit the field to leave them untouched)', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, documentDeleteConflict: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/expenses/{id}/comments': {
      post: op({ summary: 'Add expense comment', tag: 'SplitExpenses', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/split-expenses/recurring/{id}/pause': {
      post: op({ summary: 'Pause or resume recurring expense', tag: 'SplitExpenses', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/split-expenses/search': {
      get: op({ summary: 'Search split-expense groups, expenses, and people', tag: 'SplitExpenses' }),
    },
  };
}
