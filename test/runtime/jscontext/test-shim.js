// Tests the shim + native bindings work correctly in JSContext
(function () {
  try {
    // console methods don't throw
    console.log('test: console.log works');
    console.warn('test: console.warn works');
    console.error('test: console.error works');

    // crypto.getRandomValues fills array with random bytes
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    var hasNonZero = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] !== 0) { hasNonZero = true; break; }
    }
    assert(hasNonZero, 'getRandomValues should fill array with random bytes');

    // crypto.randomUUID returns valid UUID format
    var uuid = crypto.randomUUID();
    assert(typeof uuid === 'string', 'randomUUID should return string');
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid),
      'randomUUID should match UUID format: ' + uuid
    );

    // atob/btoa round-trip
    assertEqual(atob(btoa('hello')), 'hello', 'atob(btoa("hello"))');
    assertEqual(atob(btoa('')), '', 'atob(btoa(""))');
    assertEqual(atob(btoa('abc123!@#')), 'abc123!@#', 'atob(btoa("abc123!@#"))');

    // TextDecoder UTF-8
    var bytes = new Uint8Array([72, 101, 108, 108, 111]);
    var decoded = new TextDecoder('utf-8').decode(bytes);
    assertEqual(decoded, 'Hello', 'TextDecoder UTF-8');

    // setTimeout calls the callback
    var called = false;
    setTimeout(function () { called = true; }, 0);
    assert(called, 'setTimeout callback should be called');

    // AbortController - abort sets signal.aborted
    var ac = new AbortController();
    assert(!ac.signal.aborted, 'signal should not be aborted initially');
    ac.abort();
    assert(ac.signal.aborted, 'signal should be aborted after abort()');

    // MessageChannel - port1.postMessage reaches port2.onmessage
    var received = null;
    var ch = new MessageChannel();
    ch.port2.onmessage = function (e) { received = e.data; };
    ch.port1.postMessage('test-message');
    assertEqual(received, 'test-message', 'MessageChannel port1->port2');

    console.log('All shim tests passed');
    reportPass();
  }
  catch (e) {
    console.error('Shim test failed: ' + e);
    reportFail(e);
  }
})();
