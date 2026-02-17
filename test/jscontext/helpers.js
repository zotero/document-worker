// Shared test utilities for JSContext tests
(function () {
  var g = globalThis;

  g.assert = function (condition, message) {
    if (!condition) {
      throw new Error('Assertion failed: ' + (message || ''));
    }
  };

  g.assertEqual = function (actual, expected, message) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a !== e) {
      throw new Error('assertEqual failed: ' + (message || '') +
        '\n  actual:   ' + a +
        '\n  expected: ' + e);
    }
  };

  g.loadPDF = function (path) {
    var bytes = __nativeReadFileBytes(path);
    assert(bytes.length > 0, 'Failed to load PDF: ' + path);
    return new Uint8Array(bytes);
  };

  g.dataProvider = function (path) {
    var bytes = __nativeReadFileBytes('build/' + path);
    if (!bytes || bytes.length === 0) return null;
    return new Uint8Array(bytes).buffer;
  };

  g.reportPass = function () {
    __nativeReportResult(JSON.stringify({ pass: true }));
  };

  g.reportFail = function (error) {
    __nativeReportResult(JSON.stringify({ pass: false, error: String(error) }));
  };
})();
