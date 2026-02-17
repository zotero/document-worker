// Integration test: dataProvider resolves CMap data for CJK fonts
(async function () {
  try {
    var buf = loadPDF('test/pdfs/issue3521.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.getFulltext(buf, 1, '', dataProvider);

    assert(result, 'getFulltext should return a result');
    assert(typeof result.text === 'string', 'result.text should be a string');
    assert(result.text.length > 0, 'result.text should not be empty');

    console.log('Fulltext length: ' + result.text.length);
    console.log('Total pages: ' + result.totalPages);

    reportPass();
  }
  catch (e) {
    console.error('CMap test failed: ' + e);
    reportFail(e);
  }
})();
