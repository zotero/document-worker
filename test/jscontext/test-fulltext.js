// Integration test: getFulltext via JSContext
(async function () {
  try {
    var buf = loadPDF('test/pdfs/full/1.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.getFulltext(buf, null, '', dataProvider);

    assert(result, 'getFulltext should return a result');
    assert(typeof result.text === 'string', 'result.text should be a string');
    assert(result.text.length > 0, 'result.text should not be empty');
    assert(typeof result.totalPages === 'number', 'result.totalPages should be a number');
    assert(result.totalPages > 0, 'totalPages should be > 0');

    console.log('Fulltext length: ' + result.text.length);
    console.log('Total pages: ' + result.totalPages);

    reportPass();
  }
  catch (e) {
    console.error('Fulltext test failed: ' + e);
    reportFail(e);
  }
})();
