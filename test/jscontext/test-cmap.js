// Integration test: dataProvider resolves CMap data for CJK fonts
(async function () {
  try {
    var buf = loadPDF('test/pdfs/special/cjk-cmap.pdf');

    var fetched = [];
    function trackingProvider(path) {
      fetched.push(path);
      return dataProvider(path);
    }

    var result = await worker.getFulltext(buf, 1, '', trackingProvider);

    assert(result, 'getFulltext should return a result');
    assert(typeof result.text === 'string', 'result.text should be a string');

    // Verify CMap data was requested and loaded
    var cmapPaths = fetched.filter(function (p) { return p.indexOf('cmaps/') === 0; });
    assert(cmapPaths.length > 0, 'should have fetched CMap data, fetched: ' + fetched.join(', '));

    reportPass();
  }
  catch (e) {
    reportFail(e);
  }
})();
