(async function () {
  try {
    function assertStructure(result, type) {
      assert(result, type + ' should return a result');
      assert(result.processor && result.processor.type === type, type + ' processor type');
      assert(result.schemaVersion, type + ' should have schemaVersion');
      assert(Array.isArray(result.pages), type + ' pages should be array');
      assert(result.pages.length > 0, type + ' should have pages');
      assert(Array.isArray(result.content), type + ' content should be array');
      assert(result.content.length > 0, type + ' should have content blocks');
      assert(result.content[0].type, type + ' block should have type');
    }

    var pdf = loadPDF('test/fixtures/pdf/full/1.pdf');
    var pdfResult = await worker.getStructuredDocumentText(pdf, {
      contentType: 'application/pdf',
      password: '',
      dataProvider
    });
    assertStructure(pdfResult, 'pdf');

    var epub = loadBytes('test/fixtures/epub/1.epub');
    var epubResult = await worker.getStructuredDocumentText(epub, {
      contentType: 'application/epub+zip'
    });
    assertStructure(epubResult, 'epub');

    var snapshot = loadBytes('test/fixtures/snapshot/1.html');
    var snapshotResult = await worker.getStructuredDocumentText(snapshot, {
      contentType: 'text/html'
    });
    assertStructure(snapshotResult, 'snapshot');

    reportPass();
  }
  catch (e) {
    reportFail(e);
  }
})();
