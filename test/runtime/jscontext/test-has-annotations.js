// Integration test: pdf.hasAnnotations via JSContext
(async function () {
  try {
    var buf = loadPDF('test/fixtures/pdf/full/1.pdf');
    console.log('Loaded PDF: ' + buf.length + ' bytes');

    var result = await worker.pdf.hasAnnotations(buf, '');

    assert(typeof result === 'boolean', 'pdf.hasAnnotations should return a boolean');
    console.log('Has annotations: ' + result);

    reportPass();
  }
  catch (e) {
    console.error('pdf.hasAnnotations test failed: ' + e);
    reportFail(e);
  }
})();
