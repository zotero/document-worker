// Integration test: pdf.importAnnotations via JSContext
(async function () {
  try {
    var buf = loadPDF('test/fixtures/pdf/full/1.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.pdf.importAnnotations(buf, [], '', false, dataProvider);

    assert(result, 'pdf.importAnnotations should return a result');
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
