export const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function send(res, status, payload, headers = {}) {
  res.writeHead(status, { ...corsHeaders, ...jsonHeaders, ...headers });
  res.end(JSON.stringify(payload));
}

export function sendError(res, status, message) {
  send(res, status, { error: message });
}
