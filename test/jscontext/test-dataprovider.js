// Integration test: dataProvider resolves standard font data
(async function () {
  try {
    var buf = loadPDF('pdf.js/test/pdfs/TAMReview.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.getFulltext(buf, 1, '', dataProvider);

    assert(result, 'getFulltext should return a result');
    assert(typeof result.text === 'string', 'result.text should be a string');
    assert(result.text.length > 0, 'result.text should not be empty');
    assert(result.totalPages === 23, 'totalPages should be 23');

    console.log('Fulltext length: ' + result.text.length);
    console.log('Total pages: ' + result.totalPages);

    reportPass();
  }
  catch (e) {
    console.error('dataProvider test failed: ' + e);
    reportFail(e);
  }
})();
