function authSecurity() {
  return [{ bearerAuth: [] }, { apiKeyAuth: [] }, { cookieAuth: [] }];
}

function csrfHeaderParam() {
  return {
    name: 'X-CSRF-Token',
    in: 'header',
    required: false,
    description: 'Required for state-changing requests when using session/cookie authentication. Not required for API-token authentication.',
    schema: { type: 'string' },
  };
}

/**
 * Retry-Sicherheit fuer POST (#822). Steht als EIN Helfer hier und wird in
 * `buildOpenApiSpec` ueber alle POST-Operationen gelegt, statt an jeder
 * einzelnen wiederholt zu werden: die Middleware gilt fuer den ganzen
 * `/api/v1`-Namensraum, und eine handgepflegte Liste davon waere schon beim
 * naechsten neuen Endpoint unvollstaendig.
 */
function idempotencyHeaderParam() {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    description: 'Optional client-generated key (printable ASCII, max 255 chars) that makes this POST retry-safe. Repeating the request with the same key and the same body returns the original response with `Idempotent-Replayed: true` instead of creating a second record. Reusing a key for a different body, or retrying while the first attempt is still running, answers 409. Keys are stored for 24 hours and survive a restart.',
    schema: { type: 'string', maxLength: 255 },
  };
}

function jsonBody(schemaRef, description = 'JSON request body') {
  return {
    required: true,
    description,
    content: {
      'application/json': {
        schema: schemaRef ? { $ref: schemaRef } : { type: 'object', additionalProperties: true },
      },
    },
  };
}

function op({
  summary,
  tag,
  description,
  auth = true,
  admin = false,
  params = [],
  requestBody = null,
  responses = null,
  stateChanging = false,
  documentDeleteConflict = false,
}) {
  const operation = {
    tags: [tag],
    summary,
    responses: responses ?? {
      200: { description: 'Successful response' },
      401: { $ref: '#/components/responses/Unauthorized' },
      500: { $ref: '#/components/responses/InternalServerError' },
    },
  };

  if (description) operation.description = description;
  if (auth) operation.security = authSecurity();
  if (admin) {
    operation.description = `${operation.description ? `${operation.description}\n\n` : ''}Admin-only endpoint.`;
    operation.responses[403] = { $ref: '#/components/responses/Forbidden' };
  }
  if (documentDeleteConflict) {
    operation.responses[409] = {
      description: 'A requested document is being deleted. Retry after the operation finishes. The response body reason is `DOCUMENT_DELETE_IN_PROGRESS`.',
    };
  }
  if (params.length || stateChanging) {
    operation.parameters = [...params];
    if (stateChanging) operation.parameters.push(csrfHeaderParam());
  }
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

function idParam(name = 'id', description = 'Resource ID') {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'integer' },
  };
}

function stringPathParam(name, description) {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  };
}

function langParam() {
  return {
    name: 'lang',
    in: 'query',
    required: false,
    description: 'Language code for localized labels. Supported values: ar, de, el, en, es, fr, hi, it, ja, pt, ru, sv, tr, uk, zh. Defaults to en.',
    schema: {
      type: 'string',
      default: 'en',
      enum: ['ar', 'de', 'el', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'pt', 'ru', 'sv', 'tr', 'uk', 'zh'],
    },
  };
}

export { authSecurity, csrfHeaderParam, idempotencyHeaderParam, jsonBody, op, idParam, stringPathParam, langParam };
