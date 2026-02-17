// Integration test: importAnnotations via JSContext
(async function () {
  try {
    var buf = loadPDF('test/pdfs/1.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.importAnnotations(buf, [], '', false, dataProvider);

    assert(result, 'importAnnotations should return a result');
    assert(Array.isArray(result.imported), 'result.imported should be an array');

    console.log('Imported annotations: ' + result.imported.length);

    if (result.imported.length > 0) {
      var first = result.imported[0];
      assert(first.type, 'First annotation should have a type');
      console.log('First annotation type: ' + first.type);
    }

    reportPass();
  }
  catch (e) {
    console.error('Import test failed: ' + e);
    reportFail(e);
  }
})();
