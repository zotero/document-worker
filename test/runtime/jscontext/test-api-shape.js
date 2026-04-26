(function () {
  try {
    var pdfFunctions = [
      'writeAnnotations',
      'importAnnotations',
      'deletePages',
      'rotatePages',
      'getFulltext',
      'getRecognizerData',
      'importCitaviAnnotations',
      'importMendeleyAnnotations',
      'hasAnnotations'
    ];

    assert(worker && typeof worker === 'object', 'worker export should exist');
    assert(worker.pdf && typeof worker.pdf === 'object', 'worker.pdf should exist');
    assert(typeof worker.getStructuredDocumentText === 'function', 'getStructuredDocumentText should be exported');
    assert(typeof worker.getStructure === 'undefined', 'getStructure should not be exported');
    assert(typeof worker.getFulltext === 'undefined', 'top-level getFulltext should not be exported');
    assert(typeof worker.getEpubFulltext === 'undefined', 'getEpubFulltext should not be exported');
    assert(typeof worker.getSnapshotFulltext === 'undefined', 'getSnapshotFulltext should not be exported');

    for (var i = 0; i < pdfFunctions.length; i++) {
      var name = pdfFunctions[i];
      assert(typeof worker.pdf[name] === 'function', 'worker.pdf.' + name + ' should be exported');
    }

    reportPass();
  }
  catch (e) {
    reportFail(e && e.stack || e);
  }
})();
