/* eslint-disable @typescript-eslint/no-unused-vars */
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri += 'index.html';
    return request;
  }

  var finalSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (!finalSegment.includes('.')) {
    request.uri += '/index.html';
  }

  return request;
}
