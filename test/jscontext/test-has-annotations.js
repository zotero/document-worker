// Integration test: hasAnnotations via JSContext
(async function () {
  try {
    var buf = loadPDF('test/pdfs/full/1.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.hasAnnotations(buf, '');

    assert(typeof result === 'boolean', 'hasAnnotations should return a boolean');
    console.log('Has annotations: ' + result);

    reportPass();
  }
  catch (e) {
    console.error('hasAnnotations test failed: ' + e);
    reportFail(e);
  }
})();
