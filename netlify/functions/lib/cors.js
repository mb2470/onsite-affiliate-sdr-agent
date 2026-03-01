/**
 * Shared CORS helper — dynamic origin allowlisting.
 *
 * Usage (in any Netlify function):
 *   const { corsHeaders } = require('./lib/cors');
 *   const headers = corsHeaders(event);
 */

const ALLOWED_ORIGINS = [
  'https://sdr.onsiteaffiliate.com',
  'https://sdr-tester.netlify.app',
];

/**
 * Returns CORS headers with the request's Origin echoed back
 * if it matches the allowlist, otherwise the primary production origin.
 *
 * @param {object} event  Netlify function event (needs event.headers)
 * @param {object} [opts]
 * @param {string} [opts.methods]  Override Allow-Methods (default: 'GET, POST, PUT, DELETE, OPTIONS')
 * @param {string} [opts.headers]  Override Allow-Headers (default: 'Content-Type, X-Org-Id')
 */
function corsHeaders(event, opts = {}) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': opts.headers || 'Content-Type, X-Org-Id',
    'Access-Control-Allow-Methods': opts.methods || 'GET, POST, PUT, DELETE, OPTIONS',
  };
}

module.exports = { corsHeaders, ALLOWED_ORIGINS };
